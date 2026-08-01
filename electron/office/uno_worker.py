#!/usr/bin/env python3
"""Small, fixed-operation LibreOffice UNO bridge used by Office Agent.

The Node boundary validates workspace paths and request sizes. This worker only
implements the allow-listed document operations below. Its sole code-execution
path is an interactively approved, signed/trusted, document-scoped Basic macro.
"""

import json
import os
import re
import sys
import time

import uno
from com.sun.star.beans import PropertyValue


MAX_TEXT_CHARS = 100_000
MAX_ROWS = 200
MAX_COLUMNS = 50
MAX_SLIDES = 100


def property_value(name, value):
    item = PropertyValue()
    item.Name = name
    item.Value = value
    return item


def connect(pipe_name):
    local_context = uno.getComponentContext()
    resolver = local_context.ServiceManager.createInstanceWithContext(
        'com.sun.star.bridge.UnoUrlResolver', local_context
    )
    endpoint = f'uno:pipe,name={pipe_name};urp;StarOffice.ComponentContext'
    last_error = None
    for _attempt in range(300):
        try:
            return resolver.resolve(endpoint)
        except Exception as cause:  # LibreOffice needs a short startup window.
            last_error = cause
            time.sleep(0.1)
    raise RuntimeError(f'Unable to connect to LibreOffice: {last_error}')


def trust_macro_location(context, input_path):
    provider = context.ServiceManager.createInstanceWithContext(
        'com.sun.star.configuration.ConfigurationProvider', context
    )
    configuration = provider.createInstanceWithArguments(
        'com.sun.star.configuration.ConfigurationUpdateAccess',
        (property_value(
            'nodepath', '/org.openoffice.Office.Common/Security/Scripting'
        ),),
    )
    location = uno.systemPathToFileUrl(os.path.dirname(os.path.realpath(input_path)))
    if not location.endswith('/'):
        location += '/'
    configuration.SecureURL = (location,)
    configuration.commitChanges()


def load_document(desktop, input_path, read_only, trusted_macro=False):
    if not isinstance(input_path, str) or not os.path.isabs(input_path):
        raise ValueError('UNO input path must be absolute')
    macro_mode = (
        property_value('MacroExecutionMode', 9)
        if trusted_macro
        else property_value('MacroExecutionMode', 0)
    )
    document = desktop.loadComponentFromURL(
        uno.systemPathToFileUrl(input_path),
        '_blank',
        0,
        (
            property_value('Hidden', True),
            property_value('ReadOnly', bool(read_only)),
            macro_mode,
        ),
    )
    if document is None:
        raise RuntimeError('LibreOffice could not open the document')
    return document


def close_document(document):
    try:
        document.close(True)
    except Exception:
        document.dispose()


def filter_for_extension(output_path):
    extension = os.path.splitext(output_path)[1].lower()
    filters = {
        '.doc': 'MS Word 97',
        '.docx': 'Office Open XML Text',
        '.odt': 'writer8',
        '.rtf': 'Rich Text Format',
        '.xls': 'MS Excel 97',
        '.xlsx': 'Calc MS Excel 2007 XML',
        '.ods': 'calc8',
        '.ppt': 'MS PowerPoint 97',
        '.pptx': 'Impress MS PowerPoint 2007 XML',
        '.odp': 'impress8',
    }
    if extension not in filters:
        raise ValueError(f'Unsupported LibreOffice output extension: {extension}')
    return filters[extension]


def store_copy(document, output_path):
    if not isinstance(output_path, str) or not os.path.isabs(output_path):
        raise ValueError('UNO output path must be absolute')
    document.storeToURL(
        uno.systemPathToFileUrl(output_path),
        (
            property_value('FilterName', filter_for_extension(output_path)),
            property_value('Overwrite', False),
        ),
    )


def active_word_page_style(document):
    page_styles = document.StyleFamilies.getByName('PageStyles')
    cursor = document.Text.createTextCursor()
    style_name = str(cursor.PageStyleName)
    if style_name and page_styles.hasByName(style_name):
        return page_styles.getByName(style_name)
    names = list(page_styles.getElementNames())
    if not names:
        raise ValueError('The Word document contains no page styles')
    return page_styles.getByName(names[0])


def word_comments(document, character_limit):
    comments = []
    used_characters = 0
    truncated = False
    enumeration = document.TextFields.createEnumeration()
    while enumeration.hasMoreElements():
        field = enumeration.nextElement()
        if not field.supportsService('com.sun.star.text.textfield.Annotation'):
            continue
        if len(comments) >= 100:
            truncated = True
            break
        author = str(field.Author)
        content = str(field.Content)
        remaining = character_limit - used_characters - len(author)
        if remaining <= 0:
            truncated = True
            break
        if len(content) > remaining:
            content = content[:remaining]
            truncated = True
        used_characters += len(author) + len(content)
        comments.append({'author': author, 'content': content})
    return comments, used_characters, truncated


def word_read(document, _request):
    if not document.supportsService('com.sun.star.text.TextDocument'):
        raise ValueError('The selected file is not a Word document')
    body = str(document.Text.String)
    truncated = len(body) > MAX_TEXT_CHARS
    body = body[:MAX_TEXT_CHARS]
    used_characters = len(body)
    tables = []
    table_sections = []
    table_names = list(document.TextTables.getElementNames())
    if len(table_names) > 20:
        truncated = True
    for table_name in table_names[:20]:
        table = document.TextTables.getByName(table_name)
        total_rows = table.Rows.getCount()
        total_columns = table.Columns.getCount()
        row_count = min(total_rows, 50)
        column_count = min(total_columns, 20)
        table_truncated = row_count < total_rows or column_count < total_columns
        values = []
        for row_index in range(row_count):
            row = []
            for column_index in range(column_count):
                cell_name = f'{column_name(column_index)}{row_index + 1}'
                try:
                    value = str(table.getCellByName(cell_name).String)
                except Exception:
                    value = ''
                remaining = MAX_TEXT_CHARS - used_characters
                if remaining <= 0:
                    value = ''
                    table_truncated = True
                elif len(value) > remaining:
                    value = value[:remaining]
                    table_truncated = True
                used_characters += len(value)
                row.append(value)
            values.append(row)
        if table_truncated:
            truncated = True
        tables.append({
            'name': table_name,
            'values': values,
            'truncated': table_truncated,
        })
        table_sections.append('\n'.join('\t'.join(row) for row in values))
    sections = [section for section in [body, *table_sections] if section]
    text = '\n\n'.join(sections)
    if len(text) > MAX_TEXT_CHARS:
        text = text[:MAX_TEXT_CHARS]
        truncated = True
    try:
        image_count = int(document.GraphicObjects.getCount())
    except Exception:
        image_count = 0
    page_style = active_word_page_style(document)
    header = str(page_style.HeaderText.String) if page_style.HeaderIsOn else ''
    footer = str(page_style.FooterText.String) if page_style.FooterIsOn else ''
    comments, _comment_characters, comments_truncated = word_comments(
        document, max(0, MAX_TEXT_CHARS - used_characters)
    )
    return {
        'text': text,
        'tables': tables,
        'comments': comments,
        'imageCount': image_count,
        'header': header,
        'footer': footer,
        'truncated': truncated or comments_truncated,
    }


def redline_property(redline, name):
    try:
        return redline.getPropertyValue(name)
    except Exception:
        return ''


def redline_text(redline):
    value = redline_property(redline, 'RedlineText')
    try:
        return str(value.String)
    except Exception:
        return value if isinstance(value, str) else ''


def redline_timestamp(redline):
    value = redline_property(redline, 'RedlineDateTime')
    try:
        return (
            f'{int(value.Year):04d}-{int(value.Month):02d}-{int(value.Day):02d}'
            f'T{int(value.Hours):02d}:{int(value.Minutes):02d}:{int(value.Seconds):02d}'
        )
    except Exception:
        return ''


def word_read_changes(document, _request):
    if not document.supportsService('com.sun.star.text.TextDocument'):
        raise ValueError('The selected file is not a Word document')
    enumeration = document.getRedlines().createEnumeration()
    changes = []
    used_characters = 0
    truncated = False
    fields = (
        ('type', 'RedlineType', 100),
        ('author', 'RedlineAuthor', 500),
        ('comment', 'RedlineComment', 2000),
        ('identifier', 'RedlineIdentifier', 500),
    )
    while enumeration.hasMoreElements():
        if len(changes) >= 200 or used_characters >= MAX_TEXT_CHARS:
            truncated = True
            break
        redline = enumeration.nextElement()
        change = {}
        for output_name, property_name, limit in fields:
            value = str(redline_property(redline, property_name))
            remaining = MAX_TEXT_CHARS - used_characters
            bounded = value[:min(limit, remaining)]
            if len(bounded) < len(value):
                truncated = True
            change[output_name] = bounded
            used_characters += len(bounded)
        for output_name, value, limit in (
            ('timestamp', redline_timestamp(redline), 32),
            ('text', redline_text(redline), 2000),
        ):
            remaining = MAX_TEXT_CHARS - used_characters
            bounded = value[:min(limit, remaining)]
            if len(bounded) < len(value):
                truncated = True
            change[output_name] = bounded
            used_characters += len(bounded)
        changes.append(change)
    return {'changes': changes, 'truncated': truncated}


def redline_count(document):
    enumeration = document.getRedlines().createEnumeration()
    count = 0
    while enumeration.hasMoreElements():
        enumeration.nextElement()
        count += 1
    return count


def dispatch_command(document, request, command):
    context = request['_context']
    helper = context.ServiceManager.createInstanceWithContext(
        'com.sun.star.frame.DispatchHelper', context
    )
    frame = document.getCurrentController().getFrame()
    helper.executeDispatch(frame, command, '', 0, ())


def word_resolve_changes(document, request):
    if not document.supportsService('com.sun.star.text.TextDocument'):
        raise ValueError('The selected file is not a Word document')
    action = request['action']
    commands = {
        'accept': '.uno:AcceptAllTrackedChanges',
        'reject': '.uno:RejectAllTrackedChanges',
    }
    if action not in commands:
        raise ValueError('Tracked-change action must be accept or reject')
    before = redline_count(document)
    dispatch_command(document, request, commands[action])
    remaining = redline_count(document)
    store_copy(document, request['outputPath'])
    return {
        'action': action,
        'resolvedChanges': max(0, before - remaining),
        'remainingChanges': remaining,
    }


def word_replace(document, request):
    if not document.supportsService('com.sun.star.text.TextDocument'):
        raise ValueError('The selected file is not a Word document')
    descriptor = document.createReplaceDescriptor()
    descriptor.SearchString = request['find']
    descriptor.ReplaceString = request.get('replace', '')
    descriptor.SearchCaseSensitive = request.get('matchCase', True) is not False
    replacement_count = int(document.replaceAll(descriptor))
    store_copy(document, request['outputPath'])
    return {'replacementCount': replacement_count}


def word_replace_tracked(document, request):
    if not document.supportsService('com.sun.star.text.TextDocument'):
        raise ValueError('The selected file is not a Word document')
    descriptor = document.createReplaceDescriptor()
    descriptor.SearchString = request['find']
    descriptor.ReplaceString = request.get('replace', '')
    descriptor.SearchCaseSensitive = request.get('matchCase', True) is not False
    previous_record_changes = bool(document.RecordChanges)
    document.RecordChanges = True
    try:
        replacement_count = int(document.replaceAll(descriptor))
    finally:
        document.RecordChanges = previous_record_changes
    store_copy(document, request['outputPath'])
    return {'replacementCount': replacement_count}


def word_insert_table(document, request):
    if not document.supportsService('com.sun.star.text.TextDocument'):
        raise ValueError('The selected file is not a Word document')
    values = request['values']
    row_count = len(values)
    column_count = len(values[0])
    table = document.createInstance('com.sun.star.text.TextTable')
    table.initialize(row_count, column_count)
    text = document.Text
    cursor = text.createTextCursor()
    cursor.gotoEnd(False)
    if text.String:
        paragraph_break = uno.getConstantByName(
            'com.sun.star.text.ControlCharacter.PARAGRAPH_BREAK'
        )
        text.insertControlCharacter(cursor, paragraph_break, False)
    text.insertTextContent(cursor, table, False)
    has_header = request.get('hasHeader', False) is True
    for row_index, row in enumerate(values):
        for column_index, value in enumerate(row):
            cell_name = f'{column_name(column_index)}{row_index + 1}'
            cell = table.getCellByName(cell_name)
            cell.String = '' if value is None else str(value)
            if has_header and row_index == 0:
                cell.BackColor = 0xD9EAF7
                cell_cursor = cell.createTextCursor()
                cell_cursor.gotoEnd(True)
                cell_cursor.CharWeight = 150.0
    store_copy(document, request['outputPath'])
    return {'rows': row_count, 'columns': column_count}


def word_insert_image(document, request):
    if not document.supportsService('com.sun.star.text.TextDocument'):
        raise ValueError('The selected file is not a Word document')
    graphic = document.createInstance('com.sun.star.text.TextGraphicObject')
    graphic.GraphicURL = uno.systemPathToFileUrl(request['imagePath'])
    graphic.AnchorType = uno.Enum(
        'com.sun.star.text.TextContentAnchorType', 'AS_CHARACTER'
    )
    width = request.get('widthMm')
    height = request.get('heightMm')
    if width is not None:
        graphic.Width = int(round(float(width) * 100))
    if height is not None:
        graphic.Height = int(round(float(height) * 100))
    text = document.Text
    cursor = text.createTextCursor()
    cursor.gotoEnd(False)
    if text.String:
        paragraph_break = uno.getConstantByName(
            'com.sun.star.text.ControlCharacter.PARAGRAPH_BREAK'
        )
        text.insertControlCharacter(cursor, paragraph_break, False)
    text.insertTextContent(cursor, graphic, False)
    store_copy(document, request['outputPath'])
    return {'imageInserted': True}


def word_set_header_footer(document, request):
    if not document.supportsService('com.sun.star.text.TextDocument'):
        raise ValueError('The selected file is not a Word document')
    page_style = active_word_page_style(document)
    if 'header' in request:
        header = request['header']
        if header:
            page_style.HeaderIsOn = True
            page_style.HeaderText.String = header
        else:
            if page_style.HeaderIsOn:
                page_style.HeaderText.String = ''
            page_style.HeaderIsOn = False
    if 'footer' in request:
        footer = request['footer']
        if footer:
            page_style.FooterIsOn = True
            page_style.FooterText.String = footer
        else:
            if page_style.FooterIsOn:
                page_style.FooterText.String = ''
            page_style.FooterIsOn = False
    store_copy(document, request['outputPath'])
    return {
        'headerEnabled': bool(page_style.HeaderIsOn),
        'footerEnabled': bool(page_style.FooterIsOn),
    }


def word_add_comment(document, request):
    if not document.supportsService('com.sun.star.text.TextDocument'):
        raise ValueError('The selected file is not a Word document')
    descriptor = document.createSearchDescriptor()
    descriptor.SearchString = request['find']
    descriptor.SearchCaseSensitive = request.get('matchCase', True) is not False
    matches = document.findAll(descriptor)
    occurrence = int(request.get('occurrence', 1))
    match_count = matches.getCount()
    if occurrence > match_count:
        raise ValueError(
            f'Comment occurrence {occurrence} was not found; document has {match_count} matches'
        )
    selected = matches.getByIndex(occurrence - 1)
    annotation = document.createInstance('com.sun.star.text.textfield.Annotation')
    annotation.Author = request['author']
    annotation.Initials = request['initials']
    annotation.Content = request['comment']
    selected.Text.insertTextContent(selected, annotation, False)
    store_copy(document, request['outputPath'])
    return {
        'commentAdded': True,
        'author': request['author'],
        'occurrence': occurrence,
        'matchCount': match_count,
    }


def spreadsheet(document, requested_name):
    if not document.supportsService('com.sun.star.sheet.SpreadsheetDocument'):
        raise ValueError('The selected file is not an Excel workbook')
    names = list(document.Sheets.getElementNames())
    if not names:
        raise ValueError('The workbook contains no worksheets')
    name = requested_name or names[0]
    if name not in names:
        raise ValueError(f'Worksheet not found: {name}')
    return name, document.Sheets.getByName(name)


def column_name(index):
    value = index + 1
    result = ''
    while value > 0:
        value, remainder = divmod(value - 1, 26)
        result = chr(65 + remainder) + result
    return result


def range_name(address):
    start = f'{column_name(address.StartColumn)}{address.StartRow + 1}'
    end = f'{column_name(address.EndColumn)}{address.EndRow + 1}'
    return start if start == end else f'{start}:{end}'


def color_text(value):
    try:
        number = int(value)
    except Exception:
        return ''
    if number < 0:
        return ''
    return f'#{number & 0xFFFFFF:06X}'


def excel_style_summary(selected):
    try:
        weight = float(selected.CharWeight)
    except Exception:
        weight = None
    try:
        alignment = selected.HoriJustify.value.lower()
    except Exception:
        alignment = ''
    try:
        optimal_width = bool(selected.Columns.OptimalWidth)
    except Exception:
        optimal_width = None
    return {
        'bold': weight >= 150.0 if weight is not None else None,
        'backgroundColor': color_text(selected.CellBackColor),
        'textColor': color_text(selected.CharColor),
        'horizontalAlignment': alignment,
        'optimalWidth': optimal_width,
    }


def same_range_address(left, right):
    return (
        left.Sheet == right.Sheet
        and left.StartColumn == right.StartColumn
        and left.StartRow == right.StartRow
        and left.EndColumn == right.EndColumn
        and left.EndRow == right.EndRow
    )


def database_range_for_address(document, address):
    database_ranges = document.DatabaseRanges
    for name in database_ranges.getElementNames():
        database_range = database_ranges.getByName(name)
        if same_range_address(database_range.getDataArea(), address):
            return name, database_range
    return '', None


def excel_read(document, request):
    sheet_name, sheet = spreadsheet(document, request.get('sheet', ''))
    requested_range = request.get('range', '')
    if requested_range:
        selected = sheet.getCellRangeByName(requested_range)
        address = selected.getRangeAddress()
    else:
        cursor = sheet.createCursor()
        cursor.gotoEndOfUsedArea(True)
        address = cursor.getRangeAddress()

    end_column = min(address.EndColumn, address.StartColumn + MAX_COLUMNS - 1)
    end_row = min(address.EndRow, address.StartRow + MAX_ROWS - 1)
    selected = sheet.getCellRangeByPosition(
        address.StartColumn, address.StartRow, end_column, end_row
    )
    selected_address = selected.getRangeAddress()
    values = [list(row) for row in selected.getDataArray()]
    raw_formulas = selected.getFormulaArray()
    formulas = [
        [formula if isinstance(formula, str) and formula.startswith('=') else None for formula in row]
        for row in raw_formulas
    ]
    style_summary = excel_style_summary(selected)
    _database_range_name, database_range = database_range_for_address(
        document, selected_address
    )
    truncated = end_column < address.EndColumn or end_row < address.EndRow
    return {
        'sheet': sheet_name,
        'range': range_name(selected_address),
        'values': values,
        'formulas': formulas,
        'styles': style_summary,
        'autoFilter': bool(database_range.AutoFilter) if database_range else False,
        'truncated': truncated,
    }


def excel_write(document, request):
    _sheet_name, sheet = spreadsheet(document, request.get('sheet', ''))
    start = sheet.getCellRangeByName(request['startCell']).getCellAddress()
    values = request['values']
    cells_written = 0
    for row_offset, row in enumerate(values):
        for column_offset, value in enumerate(row):
            cell = sheet.getCellByPosition(
                start.Column + column_offset, start.Row + row_offset
            )
            if value is None:
                cell.String = ''
            elif isinstance(value, bool):
                cell.Value = 1 if value else 0
            elif isinstance(value, (int, float)):
                cell.Value = float(value)
            elif value.startswith('='):
                cell.Formula = value
            else:
                cell.String = value
            cells_written += 1
    document.calculateAll()
    store_copy(document, request['outputPath'])
    return {'cellsWritten': cells_written}


def excel_sort_range(document, request):
    _sheet_name, sheet = spreadsheet(document, request.get('sheet', ''))
    selected = sheet.getCellRangeByName(request['range'])
    address = selected.getRangeAddress()
    key_column = int(request['keyColumn'])
    column_count = address.EndColumn - address.StartColumn + 1
    if key_column > column_count:
        raise ValueError(
            f'key_column must be between 1 and the selected range width ({column_count})'
        )
    sort_field = uno.createUnoStruct('com.sun.star.table.TableSortField')
    sort_field.Field = key_column - 1
    sort_field.IsAscending = request.get('ascending', True) is not False
    sort_field.IsCaseSensitive = request.get('caseSensitive', False) is True
    sort_field.FieldType = uno.Enum(
        'com.sun.star.table.TableSortFieldType', 'AUTOMATIC'
    )
    descriptor = (
        property_value(
            'SortFields',
            uno.Any(
                '[]com.sun.star.table.TableSortField', (sort_field,)
            ),
        ),
        property_value(
            'ContainsHeader', request.get('containsHeader', True) is not False
        ),
    )
    selected.sort(descriptor)
    document.calculateAll()
    store_copy(document, request['outputPath'])
    return {
        'sortedRange': range_name(address),
        'keyColumn': key_column,
        'ascending': sort_field.IsAscending,
    }


def unique_database_range_name(database_ranges):
    base = 'MagiesFilter'
    if not database_ranges.hasByName(base):
        return base
    suffix = 2
    while database_ranges.hasByName(f'{base} ({suffix})'):
        suffix += 1
    return f'{base} ({suffix})'


def excel_apply_autofilter(document, request):
    _sheet_name, sheet = spreadsheet(document, request.get('sheet', ''))
    selected = sheet.getCellRangeByName(request['range'])
    address = selected.getRangeAddress()
    database_range_name, database_range = database_range_for_address(document, address)
    if database_range is None:
        database_ranges = document.DatabaseRanges
        database_range_name = unique_database_range_name(database_ranges)
        database_ranges.addNewByName(database_range_name, address)
        database_range = database_ranges.getByName(database_range_name)
    database_range.ContainsHeader = True
    database_range.AutoFilter = True
    store_copy(document, request['outputPath'])
    return {
        'filterRange': range_name(address),
        'databaseRange': database_range_name,
    }


def color_number(value):
    if not value:
        return None
    return int(value[1:], 16)


def excel_format_range(document, request):
    _sheet_name, sheet = spreadsheet(document, request.get('sheet', ''))
    selected = sheet.getCellRangeByName(request['range'])
    if 'bold' in request and request['bold'] is not None:
        selected.CharWeight = 150.0 if request['bold'] else 100.0
    background = color_number(request.get('backgroundColor'))
    if background is not None:
        selected.CellBackColor = background
    text_color = color_number(request.get('textColor'))
    if text_color is not None:
        selected.CharColor = text_color
        address = selected.getRangeAddress()
        for row in range(address.StartRow, address.EndRow + 1):
            for column in range(address.StartColumn, address.EndColumn + 1):
                cell = sheet.getCellByPosition(column, row)
                cell.CharColor = text_color
                cell_cursor = cell.createTextCursor()
                cell_cursor.gotoEnd(True)
                cell_cursor.CharColorTheme = -1
                cell_cursor.CharColor = text_color
    alignment = request.get('horizontalAlignment')
    if alignment:
        selected.HoriJustify = uno.Enum(
            'com.sun.star.table.CellHoriJustify', alignment.upper()
        )
    if 'optimalWidth' in request and request['optimalWidth'] is not None:
        selected.Columns.OptimalWidth = bool(request['optimalWidth'])
    formatted_range = range_name(selected.getRangeAddress())
    store_copy(document, request['outputPath'])
    return {'formattedRange': formatted_range}


def unique_conditional_style_name(cell_styles):
    base = 'MagiesConditional'
    if not cell_styles.hasByName(base):
        return base
    suffix = 2
    while cell_styles.hasByName(f'{base} ({suffix})'):
        suffix += 1
    return f'{base} ({suffix})'


def excel_add_conditional_format(document, request):
    _sheet_name, sheet = spreadsheet(document, request.get('sheet', ''))
    selected = sheet.getCellRangeByName(request['range'])
    cell_styles = document.StyleFamilies.getByName('CellStyles')
    style_name = unique_conditional_style_name(cell_styles)
    style = document.createInstance('com.sun.star.style.CellStyle')
    cell_styles.insertByName(style_name, style)
    style = cell_styles.getByName(style_name)
    background = color_number(request.get('backgroundColor'))
    if background is not None:
        style.CellBackColor = background
    text_color = color_number(request.get('textColor'))
    if text_color is not None:
        style.CharColor = text_color
    if 'bold' in request and request['bold'] is not None:
        style.CharWeight = 150.0 if request['bold'] else 100.0
    address = selected.getRangeAddress()
    source_position = sheet.getCellByPosition(
        address.StartColumn, address.StartRow
    ).getCellAddress()
    properties = [
        property_value(
            'Operator',
            uno.Enum(
                'com.sun.star.sheet.ConditionOperator', request['operator']
            ),
        ),
        property_value('Formula1', request['formula1']),
        property_value('SourcePosition', source_position),
        property_value('StyleName', style_name),
    ]
    if request.get('formula2'):
        properties.append(property_value('Formula2', request['formula2']))
    conditional_format = selected.ConditionalFormat
    conditional_format.addNew(tuple(properties))
    selected.ConditionalFormat = conditional_format
    store_copy(document, request['outputPath'])
    return {
        'formattedRange': range_name(address),
        'styleName': style_name,
    }


def unique_chart_name(charts, requested_name):
    base = requested_name or 'Chart'
    existing = set(charts.getElementNames())
    if base not in existing:
        return base
    suffix = 2
    while f'{base} ({suffix})' in existing:
        suffix += 1
    return f'{base} ({suffix})'


def excel_create_chart(document, request):
    _sheet_name, sheet = spreadsheet(document, request.get('sheet', ''))
    selected = sheet.getCellRangeByName(request['dataRange'])
    charts = sheet.Charts
    chart_name = unique_chart_name(
        charts, request.get('chartName') or request.get('title') or 'Chart'
    )
    rectangle = uno.createUnoStruct('com.sun.star.awt.Rectangle')
    rectangle.X = 1000
    rectangle.Y = 1000
    rectangle.Width = 16000
    rectangle.Height = 9000
    charts.addNewByName(
        chart_name,
        rectangle,
        (selected.getRangeAddress(),),
        request.get('firstColumnLabels', True) is not False,
        request.get('firstRowLabels', True) is not False,
    )
    chart_document = charts.getByName(chart_name).EmbeddedObject
    chart_type = request['chartType']
    services = {
        'column': 'com.sun.star.chart.BarDiagram',
        'bar': 'com.sun.star.chart.BarDiagram',
        'line': 'com.sun.star.chart.LineDiagram',
        'pie': 'com.sun.star.chart.PieDiagram',
        'area': 'com.sun.star.chart.AreaDiagram',
    }
    diagram = chart_document.createInstance(services[chart_type])
    if chart_type in ('column', 'bar'):
        diagram.Vertical = chart_type == 'column'
    chart_document.Diagram = diagram
    title = request.get('title', '')
    if title:
        chart_document.Title.String = title
    store_copy(document, request['outputPath'])
    return {'chartName': chart_name}


def data_pilot_field(fields, requested_name):
    available = []
    for index in range(fields.getCount()):
        field = fields.getByIndex(index)
        field_name = str(field.Name)
        available.append(field_name)
        if field_name == requested_name:
            return field
    raise ValueError(
        f'Pivot field {requested_name!r} was not found; available fields: '
        + ', '.join(available)
    )


def unique_pivot_name(tables, requested_name):
    base = requested_name or 'MagiesPivot'
    if not tables.hasByName(base):
        return base
    suffix = 2
    while tables.hasByName(f'{base} ({suffix})'):
        suffix += 1
    return f'{base} ({suffix})'


def excel_create_pivot(document, request):
    _source_sheet_name, source_sheet = spreadsheet(
        document, request.get('sourceSheet', '')
    )
    source_address = source_sheet.getCellRangeByName(
        request['sourceRange']
    ).getRangeAddress()
    sheets = document.Sheets
    destination_sheet_name = request.get('destinationSheet', 'Pivot')
    if not sheets.hasByName(destination_sheet_name):
        sheets.insertNewByName(destination_sheet_name, sheets.getCount())
    destination_sheet = sheets.getByName(destination_sheet_name)
    tables = destination_sheet.getDataPilotTables()
    descriptor = tables.createDataPilotDescriptor()
    descriptor.setSourceRange(source_address)
    fields = descriptor.getDataPilotFields()
    row_field = data_pilot_field(fields, request['rowField'])
    row_field.Orientation = uno.Enum(
        'com.sun.star.sheet.DataPilotFieldOrientation', 'ROW'
    )
    column_field_name = request.get('columnField', '')
    if column_field_name:
        column_field = data_pilot_field(fields, column_field_name)
        column_field.Orientation = uno.Enum(
            'com.sun.star.sheet.DataPilotFieldOrientation', 'COLUMN'
        )
    data_field = data_pilot_field(fields, request['dataField'])
    data_field.Orientation = uno.Enum(
        'com.sun.star.sheet.DataPilotFieldOrientation', 'DATA'
    )
    data_field.Function = uno.Enum(
        'com.sun.star.sheet.GeneralFunction', request['dataFunction']
    )
    output_address = destination_sheet.getCellRangeByName(
        request['destinationCell']
    ).getCellAddress()
    pivot_name = unique_pivot_name(tables, request.get('pivotName', ''))
    tables.insertNewByName(pivot_name, output_address, descriptor)
    pivot_table = tables.getByName(pivot_name)
    output_range = pivot_table.getOutputRange()
    store_copy(document, request['outputPath'])
    return {
        'pivotName': pivot_name,
        'destinationSheet': destination_sheet_name,
        'outputRange': range_name(output_range),
    }


def presentation(document):
    if not document.supportsService('com.sun.star.presentation.PresentationDocument'):
        raise ValueError('The selected file is not a PowerPoint presentation')
    return document.getDrawPages()


def slide_texts(slide):
    texts = []
    for index in range(slide.getCount()):
        shape = slide.getByIndex(index)
        try:
            text = str(shape.String)
        except Exception:
            continue
        if text:
            texts.append(text)
    return texts


def note_shapes(notes_page):
    shapes = []
    for index in range(notes_page.getCount()):
        shape = notes_page.getByIndex(index)
        if shape.getShapeType() == 'com.sun.star.presentation.NotesShape':
            shapes.append(shape)
    return shapes


def slide_notes(slide):
    notes_page = slide.getNotesPage()
    for shape in note_shapes(notes_page):
        try:
            notes = str(shape.String)
        except Exception:
            continue
        if notes:
            return notes
    return ''


def slide_image_count(slide):
    count = 0
    for index in range(slide.getCount()):
        shape = slide.getByIndex(index)
        if shape.supportsService('com.sun.star.drawing.GraphicObjectShape'):
            count += 1
    return count


def slide_tables(slide, character_limit):
    tables = []
    used_characters = 0
    truncated = False
    for index in range(slide.getCount()):
        shape = slide.getByIndex(index)
        if shape.getShapeType() != 'com.sun.star.drawing.TableShape':
            continue
        if len(tables) >= 20:
            truncated = True
            break
        table = shape.Model
        total_rows = table.Rows.getCount()
        total_columns = table.Columns.getCount()
        row_count = min(total_rows, 20)
        column_count = min(total_columns, 10)
        values = []
        table_truncated = row_count < total_rows or column_count < total_columns
        for row_index in range(row_count):
            row = []
            for column_index in range(column_count):
                value = str(table.getCellByPosition(column_index, row_index).String)
                remaining = character_limit - used_characters
                if remaining <= 0:
                    value = ''
                    table_truncated = True
                elif len(value) > remaining:
                    value = value[:remaining]
                    table_truncated = True
                used_characters += len(value)
                row.append(value)
            values.append(row)
        tables.append({'values': values, 'truncated': table_truncated})
        if table_truncated:
            truncated = True
    return tables, used_characters, truncated


def presentation_read(document, _request):
    pages = presentation(document)
    slides = []
    total_characters = 0
    truncated = pages.getCount() > MAX_SLIDES
    for index in range(min(pages.getCount(), MAX_SLIDES)):
        slide = pages.getByIndex(index)
        text = '\n'.join(slide_texts(slide))
        notes = slide_notes(slide)
        remaining = MAX_TEXT_CHARS - total_characters
        if remaining <= 0:
            truncated = True
            break
        if len(text) > remaining:
            text = text[:remaining]
            notes = ''
            truncated = True
        elif len(notes) > remaining - len(text):
            notes = notes[:remaining - len(text)]
            truncated = True
        tables, table_characters, tables_truncated = slide_tables(
            slide,
            max(0, remaining - len(text) - len(notes)),
        )
        if tables_truncated:
            truncated = True
        slides.append({
            'number': index + 1,
            'text': text,
            'notes': notes,
            'imageCount': slide_image_count(slide),
            'tables': tables,
        })
        total_characters += len(text) + len(notes) + table_characters
    return {'slides': slides, 'truncated': truncated}


def presentation_replace(document, request):
    pages = presentation(document)
    find = request['find']
    replace = request.get('replace', '')
    match_case = request.get('matchCase', True) is not False
    replacement_count = 0
    pattern = re.compile(re.escape(find), 0 if match_case else re.IGNORECASE)
    for page_index in range(pages.getCount()):
        slide = pages.getByIndex(page_index)
        for shape_index in range(slide.getCount()):
            shape = slide.getByIndex(shape_index)
            try:
                original = str(shape.String)
            except Exception:
                continue
            changed, count = pattern.subn(replace, original)
            if count > 0:
                shape.String = changed
                replacement_count += count
    store_copy(document, request['outputPath'])
    return {'replacementCount': replacement_count}


def add_text_shape(document, slide, text, x, y, width, height, size, bold=False):
    shape = document.createInstance('com.sun.star.drawing.TextShape')
    position = uno.createUnoStruct('com.sun.star.awt.Point')
    position.X = int(x)
    position.Y = int(y)
    dimensions = uno.createUnoStruct('com.sun.star.awt.Size')
    dimensions.Width = int(width)
    dimensions.Height = int(height)
    shape.Position = position
    shape.Size = dimensions
    slide.add(shape)
    shape.String = text
    cursor = shape.createTextCursor()
    cursor.gotoEnd(True)
    cursor.CharHeight = float(size)
    if bold:
        cursor.CharWeight = 150.0


def presentation_add_slide(document, request):
    pages = presentation(document)
    slide_count = pages.getCount()
    after_slide = request.get('afterSlide')
    insert_index = slide_count if after_slide is None else int(after_slide)
    if insert_index < 0 or insert_index > slide_count:
        raise ValueError(f'after_slide must be between 0 and {slide_count}')
    slide = pages.insertNewByIndex(insert_index)
    page_width = int(slide.Width)
    page_height = int(slide.Height)
    title = request.get('title', '')
    body = request.get('body', [])
    if title:
        add_text_shape(
            document, slide, title,
            1000, 800, page_width - 2000, 2500, 26, True
        )
    if body:
        body_text = '\n'.join(f'• {item}' for item in body)
        add_text_shape(
            document, slide, body_text,
            1400, 4000, page_width - 2800, page_height - 5000, 18
        )
    store_copy(document, request['outputPath'])
    return {'slideNumber': insert_index + 1, 'slidesTotal': pages.getCount()}


def presentation_duplicate_slide(document, request):
    pages = presentation(document)
    slide_number = int(request['slideNumber'])
    source = presentation_slide_by_number(pages, slide_number)
    document.duplicate(source)
    store_copy(document, request['outputPath'])
    return {
        'sourceSlideNumber': slide_number,
        'duplicatedSlideNumber': slide_number + 1,
        'slidesTotal': pages.getCount(),
    }


def presentation_delete_slide(document, request):
    pages = presentation(document)
    slide_count = pages.getCount()
    if slide_count <= 1:
        raise ValueError('A presentation must keep at least one slide')
    slide_number = int(request['slideNumber'])
    if slide_number < 1 or slide_number > slide_count:
        raise ValueError(f'slide_number must be between 1 and {slide_count}')
    pages.remove(pages.getByIndex(slide_number - 1))
    store_copy(document, request['outputPath'])
    return {
        'deletedSlideNumber': slide_number,
        'slidesRemaining': pages.getCount(),
    }


def presentation_slide_by_number(pages, slide_number):
    if slide_number < 1 or slide_number > pages.getCount():
        raise ValueError(f'slide_number must be between 1 and {pages.getCount()}')
    return pages.getByIndex(slide_number - 1)


def presentation_insert_image(document, request):
    pages = presentation(document)
    slide_number = int(request['slideNumber'])
    slide = presentation_slide_by_number(pages, slide_number)
    shape = document.createInstance('com.sun.star.drawing.GraphicObjectShape')
    position = uno.createUnoStruct('com.sun.star.awt.Point')
    position.X = int(round(float(request['xMm']) * 100))
    position.Y = int(round(float(request['yMm']) * 100))
    dimensions = uno.createUnoStruct('com.sun.star.awt.Size')
    dimensions.Width = int(round(float(request['widthMm']) * 100))
    dimensions.Height = int(round(float(request['heightMm']) * 100))
    shape.Position = position
    shape.Size = dimensions
    shape.GraphicURL = uno.systemPathToFileUrl(request['imagePath'])
    slide.add(shape)
    store_copy(document, request['outputPath'])
    return {'imageInserted': True, 'slideNumber': slide_number}


def resize_table(table, row_count, column_count):
    current_rows = table.Rows.getCount()
    if row_count > current_rows:
        table.Rows.insertByIndex(current_rows, row_count - current_rows)
    elif row_count < current_rows:
        table.Rows.removeByIndex(row_count, current_rows - row_count)
    current_columns = table.Columns.getCount()
    if column_count > current_columns:
        table.Columns.insertByIndex(current_columns, column_count - current_columns)
    elif column_count < current_columns:
        table.Columns.removeByIndex(column_count, current_columns - column_count)


def presentation_insert_table(document, request):
    pages = presentation(document)
    slide_number = int(request['slideNumber'])
    slide = presentation_slide_by_number(pages, slide_number)
    values = request['values']
    row_count = len(values)
    column_count = len(values[0])
    shape = document.createInstance('com.sun.star.drawing.TableShape')
    position = uno.createUnoStruct('com.sun.star.awt.Point')
    position.X = int(round(float(request['xMm']) * 100))
    position.Y = int(round(float(request['yMm']) * 100))
    dimensions = uno.createUnoStruct('com.sun.star.awt.Size')
    dimensions.Width = int(round(float(request['widthMm']) * 100))
    dimensions.Height = int(round(float(request['heightMm']) * 100))
    shape.Position = position
    shape.Size = dimensions
    slide.add(shape)
    table = shape.Model
    resize_table(table, row_count, column_count)
    has_header = request.get('hasHeader', False) is True
    for row_index, row in enumerate(values):
        for column_index, value in enumerate(row):
            cell = table.getCellByPosition(column_index, row_index)
            cell.String = '' if value is None else str(value)
            if has_header and row_index == 0:
                cell.FillColor = 0xD9EAF7
                cursor = cell.createTextCursor()
                cursor.gotoEnd(True)
                cursor.CharWeight = 150.0
    store_copy(document, request['outputPath'])
    return {
        'slideNumber': slide_number,
        'rows': row_count,
        'columns': column_count,
    }


def presentation_set_notes(document, request):
    pages = presentation(document)
    slide_number = int(request['slideNumber'])
    slide = presentation_slide_by_number(pages, slide_number)
    notes_page = slide.getNotesPage()
    existing_shapes = note_shapes(notes_page)
    notes_shape = None
    for candidate in existing_shapes:
        try:
            if str(candidate.String):
                notes_shape = candidate
                break
        except Exception:
            continue
    if notes_shape is None and existing_shapes:
        notes_shape = existing_shapes[0]
    notes = request.get('notes', '')
    if notes_shape is None and notes:
        notes_shape = document.createInstance('com.sun.star.presentation.NotesShape')
        position = uno.createUnoStruct('com.sun.star.awt.Point')
        position.X = 2000
        position.Y = 7000
        dimensions = uno.createUnoStruct('com.sun.star.awt.Size')
        dimensions.Width = max(1000, int(notes_page.Width) - 4000)
        dimensions.Height = max(1000, int(notes_page.Height) - 9000)
        notes_shape.Position = position
        notes_shape.Size = dimensions
        notes_page.add(notes_shape)
    for candidate in existing_shapes:
        candidate.String = ''
    if notes_shape is not None:
        notes_shape.String = notes
    store_copy(document, request['outputPath'])
    return {'noteCharacters': len(notes), 'slideNumber': slide_number}


def macro_result(value):
    if value is None or isinstance(value, (bool, int, float, str)):
        return value if not isinstance(value, str) else value[:2000]
    return str(value)[:2000]


def macro_run(document, request):
    provider = document.getScriptProvider()
    script = provider.getScript(request['scriptUri'])
    return_value, _out_parameters, _out_indices = script.invoke(
        tuple(request.get('arguments', [])), (), ()
    )
    document.store()
    return {'returnValue': macro_result(return_value)}


def replace_text(original, replacements):
    changed = original
    replacement_count = 0
    for find, replacement in replacements.items():
        count = changed.count(find)
        if count:
            changed = changed.replace(find, replacement)
            replacement_count += count
    return changed, replacement_count


def template_fill_word(document, replacements):
    replacement_count = 0
    for find, replacement in replacements.items():
        descriptor = document.createReplaceDescriptor()
        descriptor.SearchString = find
        descriptor.ReplaceString = replacement
        descriptor.SearchCaseSensitive = True
        replacement_count += int(document.replaceAll(descriptor))
    return replacement_count


def template_fill_excel(document, replacements):
    replacement_count = 0
    visited_cells = 0
    for sheet_name in document.Sheets.getElementNames():
        sheet = document.Sheets.getByName(sheet_name)
        cursor = sheet.createCursor()
        cursor.gotoEndOfUsedArea(True)
        address = cursor.getRangeAddress()
        cell_count = (
            (address.EndRow - address.StartRow + 1)
            * (address.EndColumn - address.StartColumn + 1)
        )
        visited_cells += cell_count
        if visited_cells > 5000:
            raise ValueError('Template filling supports at most 5000 used spreadsheet cells')
        for row in range(address.StartRow, address.EndRow + 1):
            for column in range(address.StartColumn, address.EndColumn + 1):
                cell = sheet.getCellByPosition(column, row)
                if str(cell.Formula).startswith('='):
                    continue
                changed, count = replace_text(str(cell.String), replacements)
                if count:
                    cell.String = changed
                    replacement_count += count
    document.calculateAll()
    return replacement_count


def template_fill_presentation(document, replacements):
    replacement_count = 0
    pages = presentation(document)
    for page_index in range(pages.getCount()):
        slide = pages.getByIndex(page_index)
        for page in (slide, slide.getNotesPage()):
            for shape_index in range(page.getCount()):
                shape = page.getByIndex(shape_index)
                try:
                    original = str(shape.String)
                except Exception:
                    continue
                changed, count = replace_text(original, replacements)
                if count:
                    shape.String = changed
                    replacement_count += count
    return replacement_count


def template_fill(document, request):
    replacements = request['replacements']
    if document.supportsService('com.sun.star.text.TextDocument'):
        document_type = 'word'
        replacement_count = template_fill_word(document, replacements)
    elif document.supportsService('com.sun.star.sheet.SpreadsheetDocument'):
        document_type = 'excel'
        replacement_count = template_fill_excel(document, replacements)
    elif document.supportsService('com.sun.star.presentation.PresentationDocument'):
        document_type = 'presentation'
        replacement_count = template_fill_presentation(document, replacements)
    else:
        raise ValueError('The selected file is not a supported Office template')
    store_copy(document, request['outputPath'])
    return {
        'documentType': document_type,
        'replacementCount': replacement_count,
    }


def convert_pdf(document, request):
    if document.supportsService('com.sun.star.text.TextDocument'):
        filter_name = 'writer_pdf_Export'
    elif document.supportsService('com.sun.star.sheet.SpreadsheetDocument'):
        filter_name = 'calc_pdf_Export'
        document.calculateAll()
    elif (
        document.supportsService('com.sun.star.presentation.PresentationDocument')
        or document.supportsService('com.sun.star.drawing.DrawingDocument')
    ):
        filter_name = 'impress_pdf_Export'
    else:
        raise ValueError('The selected file cannot be converted to PDF')
    document.storeToURL(
        uno.systemPathToFileUrl(request['outputPath']),
        (
            property_value('FilterName', filter_name),
            property_value('Overwrite', False),
        ),
    )
    return {'converted': True}


OPERATIONS = {
    'word_read': (True, word_read),
    'word_read_changes': (True, word_read_changes),
    'word_resolve_changes': (False, word_resolve_changes),
    'word_replace': (False, word_replace),
    'word_replace_tracked': (False, word_replace_tracked),
    'word_insert_table': (False, word_insert_table),
    'word_insert_image': (False, word_insert_image),
    'word_set_header_footer': (False, word_set_header_footer),
    'word_add_comment': (False, word_add_comment),
    'excel_read': (True, excel_read),
    'excel_write': (False, excel_write),
    'excel_sort_range': (False, excel_sort_range),
    'excel_apply_autofilter': (False, excel_apply_autofilter),
    'excel_format_range': (False, excel_format_range),
    'excel_add_conditional_format': (False, excel_add_conditional_format),
    'excel_create_chart': (False, excel_create_chart),
    'excel_create_pivot': (False, excel_create_pivot),
    'presentation_read': (True, presentation_read),
    'presentation_replace': (False, presentation_replace),
    'presentation_add_slide': (False, presentation_add_slide),
    'presentation_duplicate_slide': (False, presentation_duplicate_slide),
    'presentation_delete_slide': (False, presentation_delete_slide),
    'presentation_insert_image': (False, presentation_insert_image),
    'presentation_insert_table': (False, presentation_insert_table),
    'presentation_set_notes': (False, presentation_set_notes),
    'template_fill': (False, template_fill),
    'macro_run': (False, macro_run),
    'convert_pdf': (True, convert_pdf),
}


def execute(request):
    operation = request.get('operation')
    if operation not in OPERATIONS:
        raise ValueError(f'Unsupported UNO operation: {operation}')
    read_only, handler = OPERATIONS[operation]
    context = connect(request['pipeName'])
    if operation == 'macro_run':
        trust_macro_location(context, request.get('inputPath'))
    desktop = context.ServiceManager.createInstanceWithContext(
        'com.sun.star.frame.Desktop', context
    )
    request['_context'] = context
    document = load_document(
        desktop,
        request.get('inputPath'),
        read_only,
        trusted_macro=operation == 'macro_run',
    )
    try:
        return handler(document, request)
    finally:
        close_document(document)
        try:
            desktop.terminate()
        except Exception:
            pass


def main():
    if len(sys.argv) != 3:
        raise ValueError('Expected request and result file paths')
    request_path, result_path = sys.argv[1], sys.argv[2]
    try:
        with open(request_path, 'r', encoding='utf-8') as request_file:
            request = json.load(request_file)
        payload = {'ok': True, 'result': execute(request)}
    except Exception as cause:
        payload = {'ok': False, 'error': f'{type(cause).__name__}: {cause}'}
    with open(result_path, 'w', encoding='utf-8') as result_file:
        json.dump(payload, result_file, ensure_ascii=False)


if __name__ == '__main__':
    main()
