#!/usr/bin/env python3
"""Small, fixed-operation LibreOffice UNO bridge used by Office Agent.

The Node boundary validates workspace paths and request sizes. This worker only
implements the allow-listed document operations below; it never evaluates code
or executes commands supplied by the model.
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
    for _attempt in range(100):
        try:
            return resolver.resolve(endpoint)
        except Exception as cause:  # LibreOffice needs a short startup window.
            last_error = cause
            time.sleep(0.1)
    raise RuntimeError(f'Unable to connect to LibreOffice: {last_error}')


def load_document(desktop, input_path, read_only):
    if not isinstance(input_path, str) or not os.path.isabs(input_path):
        raise ValueError('UNO input path must be absolute')
    document = desktop.loadComponentFromURL(
        uno.systemPathToFileUrl(input_path),
        '_blank',
        0,
        (
            property_value('Hidden', True),
            property_value('ReadOnly', bool(read_only)),
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
    return {'text': text, 'tables': tables, 'truncated': truncated}


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
    truncated = end_column < address.EndColumn or end_row < address.EndRow
    return {
        'sheet': sheet_name,
        'range': range_name(selected_address),
        'values': values,
        'formulas': formulas,
        'styles': style_summary,
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


def presentation_read(document, _request):
    pages = presentation(document)
    slides = []
    total_characters = 0
    truncated = pages.getCount() > MAX_SLIDES
    for index in range(min(pages.getCount(), MAX_SLIDES)):
        text = '\n'.join(slide_texts(pages.getByIndex(index)))
        remaining = MAX_TEXT_CHARS - total_characters
        if remaining <= 0:
            truncated = True
            break
        if len(text) > remaining:
            text = text[:remaining]
            truncated = True
        slides.append({'number': index + 1, 'text': text})
        total_characters += len(text)
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
    'word_replace': (False, word_replace),
    'word_insert_table': (False, word_insert_table),
    'excel_read': (True, excel_read),
    'excel_write': (False, excel_write),
    'excel_format_range': (False, excel_format_range),
    'excel_create_chart': (False, excel_create_chart),
    'presentation_read': (True, presentation_read),
    'presentation_replace': (False, presentation_replace),
    'presentation_add_slide': (False, presentation_add_slide),
    'presentation_delete_slide': (False, presentation_delete_slide),
    'convert_pdf': (True, convert_pdf),
}


def execute(request):
    operation = request.get('operation')
    if operation not in OPERATIONS:
        raise ValueError(f'Unsupported UNO operation: {operation}')
    read_only, handler = OPERATIONS[operation]
    context = connect(request['pipeName'])
    desktop = context.ServiceManager.createInstanceWithContext(
        'com.sun.star.frame.Desktop', context
    )
    document = load_document(desktop, request.get('inputPath'), read_only)
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
