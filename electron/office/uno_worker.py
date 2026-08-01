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
    text = str(document.Text.String)
    truncated = len(text) > MAX_TEXT_CHARS
    return {'text': text[:MAX_TEXT_CHARS], 'truncated': truncated}


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
    truncated = end_column < address.EndColumn or end_row < address.EndRow
    return {
        'sheet': sheet_name,
        'range': range_name(selected_address),
        'values': values,
        'formulas': formulas,
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
    'excel_read': (True, excel_read),
    'excel_write': (False, excel_write),
    'presentation_read': (True, presentation_read),
    'presentation_replace': (False, presentation_replace),
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
