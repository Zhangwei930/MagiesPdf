#!/usr/bin/env python3
"""Small, fixed-operation LibreOffice UNO bridge used by Office Agent.

The Node boundary validates workspace paths and request sizes. This worker only
implements the allow-listed document operations below. Its sole code-execution
path is an interactively approved, signed/trusted, document-scoped Basic macro.
"""

import hashlib
import json
import os
import re
import sys
import time
import zipfile

import uno
from com.sun.star.beans import PropertyValue


"""
How long to wait for LibreOffice to accept a connection.

A fixed 30 seconds was thin: several instances starting at once — which is what
back-to-back tool calls produce, and what a machine under load makes worse —
took longer than that, and the operation failed outright rather than merely
taking longer. This must stay below `UNO_TIMEOUT_MS` in unoRunner.cjs, so the
bridge gives up before the process waiting on it does and the caller gets this
error instead of a killed subprocess. It is also paid once per attempt, and the
runner makes three, so it is a third of the budget a user waits before being
told nothing worked.

45 was still thin for one specific reason: when LibreOffice crashes, macOS holds
the *next* start behind its crash reporter. Measured, that start took 133
seconds while three attempts allowed 120 — so the operation was abandoned 13
seconds short of an instance that was on its way up, and the error named a pipe
rather than any of this.
"""
CONNECT_TIMEOUT_SECONDS = 55

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
    deadline = time.monotonic() + CONNECT_TIMEOUT_SECONDS
    while True:
        try:
            return resolver.resolve(endpoint)
        except Exception as cause:  # LibreOffice needs a startup window.
            last_error = cause
            if time.monotonic() >= deadline:
                raise RuntimeError(f'Unable to connect to LibreOffice: {last_error}')
            time.sleep(0.1)


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


"""
How many times to ask for the document before believing the answer.

Opening the acceptor is not the same as being ready to load. An instance still
coming up answers `loadComponentFromURL` with no component and raises nothing,
and the operation then failed with "could not open the document" over a file
that opens perfectly a moment later. A file the engine genuinely cannot read
fails the same way each time, so the message it ends on stays true.

The window is 15 seconds rather than the 1.6 it started at, for the same reason
the connection budget grew: after LibreOffice crashes, macOS holds the machine
behind its crash reporter, and the instance that comes up next is alive and
answering but not yet able to open anything. 1.6 seconds ran out inside that,
and reported a file that could not be opened over one that could. Nothing is
paid on a healthy load, which returns on the first ask.
"""
LOAD_ATTEMPTS = 10
LOAD_RETRY_SECONDS = 1.5


def document_lock_path(input_path):
    """Where LibreOffice writes the lock for a document: beside it, hidden."""
    directory, name = os.path.split(input_path)
    return os.path.join(directory, f'.~lock.{name}#')


def load_document(desktop, input_path, read_only, trusted_macro=False):
    if not isinstance(input_path, str) or not os.path.isabs(input_path):
        raise ValueError('UNO input path must be absolute')
    macro_mode = (
        property_value('MacroExecutionMode', 9)
        if trusted_macro
        else property_value('MacroExecutionMode', 0)
    )
    for attempt in range(LOAD_ATTEMPTS):
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
        if document is not None:
            return document
        if attempt + 1 < LOAD_ATTEMPTS:
            # The attempt that just failed still locked the document on its way
            # through. Left there, every retry is refused for a lock this very
            # process made, which is how one refusal became all of them — the
            # whole window spent asking a question already answered no.
            try:
                os.remove(document_lock_path(input_path))
            except OSError:
                pass
            time.sleep(LOAD_RETRY_SECONDS)
    # An engine that died partway through opening answers with no document too,
    # and from here that looks exactly like a file it cannot read. Asking the
    # desktop whether it is still there is what tells them apart — and only one
    # of the two is worth a fresh instance, so the caller is told which.
    try:
        desktop.getComponents()
    except Exception as cause:
        raise RuntimeError(
            f'LibreOffice stopped responding while opening the document: {cause}'
        ) from cause
    raise RuntimeError('LibreOffice could not open the document')


def close_document(document):
    """Closing is cleanup, and cleanup must not decide whether the call failed.

    `close(True)` is refused while anything still holds the document, and the
    `dispose()` fallback then raises "illegal object given!" on one the engine
    has already torn down. Neither says anything about the operation, which by
    this point has run and stored its output. Letting either escape the
    `finally` discards a result that is on disk, intermittently and with an
    error naming nothing the caller asked for.
    """
    try:
        document.close(True)
    except Exception:
        try:
            document.dispose()
        except Exception:
            pass


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


"""
Paragraph styles a generated document is built from.

The style is what makes a heading a heading: the navigator, the table of
contents and the PDF bookmarks all read the style, not the font size. Documents
converted from .docx carry the English names, which is what LibreOffice uses
internally whatever the UI language is.
"""
WORD_BLOCK_STYLES = {
    'title': 'Title',
    'subtitle': 'Subtitle',
    'heading1': 'Heading 1',
    'heading2': 'Heading 2',
    'heading3': 'Heading 3',
    'body': 'Standard',
    'bullet': 'List Bullet',
    'number': 'List Number',
    'quote': 'Quotations',
}


def word_append(document, request):
    if not document.supportsService('com.sun.star.text.TextDocument'):
        raise ValueError('The selected file is not a Word document')
    blocks = request.get('blocks') or []
    if not blocks:
        raise ValueError('blocks must contain at least one block')
    text = document.Text
    cursor = text.createTextCursor()
    cursor.gotoEnd(False)
    paragraph_break = uno.getConstantByName(
        'com.sun.star.text.ControlCharacter.PARAGRAPH_BREAK'
    )
    written = 0
    for index, block in enumerate(blocks):
        # An empty document already has one paragraph to write into; anything
        # else needs a new one, or the append lands inside the last sentence.
        if text.String or index > 0:
            text.insertControlCharacter(cursor, paragraph_break, False)
        style_name = WORD_BLOCK_STYLES.get(block.get('style'), 'Standard')
        try:
            cursor.ParaStyleName = style_name
        except Exception:
            # A document that never defined that style still gets the text.
            cursor.ParaStyleName = 'Standard'
        try:
            cursor.NumberingLevel = int(block.get('level', 0) or 0)
        except Exception:
            pass
        if index == 0 and request.get('pageBreakBefore'):
            cursor.BreakType = uno.Enum('com.sun.star.style.BreakType', 'PAGE_BEFORE')
        text.insertString(cursor, block.get('text', ''), False)
        written += 1
    store_copy(document, request['outputPath'])
    return {'blocksWritten': written}


"""
Document looks.

The same reasoning as the deck themes and the table themes: a model asked to
make a report presentable through a dozen formatting calls produces a different
half-finished document every time, and usually gives up before the contents
page. These colours sit on white paper, so they are darker than the deck's.
"""
WORD_THEMES = {
    'azure': {
        'title': 0x14395B, 'heading': 0x1F4E79, 'accent': 0x2E75B6,
        'body': 0x22252A, 'muted': 0x67727E,
    },
    'slate': {
        'title': 0x1E293B, 'heading': 0x334155, 'accent': 0x64748B,
        'body': 0x22252A, 'muted': 0x6B7280,
    },
    'forest': {
        'title': 0x14352C, 'heading': 0x1B4438, 'accent': 0x2F7A5E,
        'body': 0x22252A, 'muted': 0x6B7A72,
    },
    'plum': {
        'title': 0x40203C, 'heading': 0x5B2A56, 'accent': 0x8A4682,
        'body': 0x22252A, 'muted': 0x7A6B78,
    },
    'mono': {
        'title': 0x111111, 'heading': 0x1F1F1F, 'accent': 0x444444,
        'body': 0x22252A, 'muted': 0x767676,
    },
}

"""
The type scale, applied to the named styles rather than to paragraphs.

Sizes are points, margins 1/100 mm, line spacing a percentage. Body text is set
at 150% because a report is read, not skimmed, and because Chinese at 100% is a
solid block.
"""
WORD_STYLE_SCALE = (
    {'name': 'Title', 'size': 30, 'bold': True, 'color': 'title',
     'above': 0, 'below': 300, 'spacing': 105},
    {'name': 'Subtitle', 'size': 15, 'bold': False, 'color': 'muted',
     'above': 0, 'below': 800, 'spacing': 120},
    {'name': 'Heading 1', 'size': 20, 'bold': True, 'color': 'heading',
     'above': 700, 'below': 260, 'spacing': 110},
    {'name': 'Heading 2', 'size': 15, 'bold': True, 'color': 'heading',
     'above': 520, 'below': 200, 'spacing': 110},
    {'name': 'Heading 3', 'size': 13, 'bold': True, 'color': 'accent',
     'above': 420, 'below': 160, 'spacing': 110},
    {'name': 'Standard', 'size': 11, 'bold': False, 'color': 'body',
     'above': 0, 'below': 220, 'spacing': 150},
    {'name': 'List Bullet', 'size': 11, 'bold': False, 'color': 'body',
     'above': 0, 'below': 120, 'spacing': 140},
    {'name': 'List Number', 'size': 11, 'bold': False, 'color': 'body',
     'above': 0, 'below': 120, 'spacing': 140},
    {'name': 'Quotations', 'size': 11, 'bold': False, 'color': 'muted',
     'above': 260, 'below': 260, 'spacing': 140},
)


def proportional_spacing(percent):
    spacing = uno.createUnoStruct('com.sun.star.style.LineSpacing')
    spacing.Mode = uno.getConstantByName('com.sun.star.style.LineSpacingMode.PROP')
    spacing.Height = int(percent)
    return spacing


"""
The list style a bulleted or numbered paragraph hangs off.

A paragraph style carries its list by name, and a document created from nothing
has none attached — so `List Bullet` paragraphs come out as prose with the
markers the author wrote silently missing. These are LibreOffice's own shipped
list styles; writing "\u2022 " into the text instead would hide the problem and
leave a list nobody can edit as one.
"""
WORD_LIST_STYLES = {'List Bullet': 'List 1', 'List Number': 'Numbering 123'}


def word_apply_theme(document, theme, font):
    """
    Restyle the named styles the document already has.

    This is the whole point of composing rather than formatting: a heading is a
    heading because of its style, and the navigator, the table of contents and
    the PDF bookmarks all read the style. Formatting each paragraph instead
    leaves a document that merely looks like it has headings, and the user finds
    out when they generate the contents page.
    """
    styles = document.StyleFamilies.getByName('ParagraphStyles')
    numbering = document.StyleFamilies.getByName('NumberingStyles')
    for entry in WORD_STYLE_SCALE:
        if not styles.hasByName(entry['name']):
            # A document carries only the styles it has used, so one created
            # from nothing has no `List Bullet` at all. Without this the bullets
            # fall back to body text and the list the author wrote is silently
            # prose — which is what the whole call was for.
            try:
                styles.insertByName(
                    entry['name'],
                    document.createInstance('com.sun.star.style.ParagraphStyle'),
                )
            except Exception:
                continue
        style = styles.getByName(entry['name'])
        style.CharHeight = float(entry['size'])
        # The Asian size is a separate property. Leaving it alone is how a
        # Chinese document ends up with headings set at the body size.
        style.CharHeightAsian = float(entry['size'])
        weight = 150.0 if entry['bold'] else 100.0
        style.CharWeight = weight
        style.CharWeightAsian = weight
        style.CharColor = int(theme[entry['color']])
        if font:
            style.CharFontName = font
            style.CharFontNameAsian = font
        style.ParaTopMargin = int(entry['above'])
        style.ParaBottomMargin = int(entry['below'])
        style.ParaLineSpacing = proportional_spacing(entry['spacing'])
        if entry['name'].startswith('Heading'):
            # A heading stranded at the foot of a page with its section overleaf
            # is the commonest thing wrong with a generated report.
            style.ParaKeepTogether = True
            style.ParaSplit = False
        list_style = WORD_LIST_STYLES.get(entry['name'])
        if list_style and numbering.hasByName(list_style):
            style.NumberingStyleName = list_style

    # The contents page has a heading of its own, and it is the one thing on
    # that page: left in the default black it is the only untouched element in
    # the document.
    if styles.hasByName('Contents Heading'):
        contents = styles.getByName('Contents Heading')
        contents.CharColor = int(theme['heading'])
        if font:
            contents.CharFontName = font
            contents.CharFontNameAsian = font


def word_text_columns(document, page, count, gap_mm, rule):
    """
    Real columns, set on the page.

    A two-column table looks the same on page one and then refuses to flow: the
    text stops at the bottom of the first cell instead of continuing in the next
    column. Columns are a property of the section, and only that fills a page.
    """
    columns = document.createInstance('com.sun.star.text.TextColumns')
    columns.setColumnCount(int(count))
    gap = int(round(float(gap_mm) * 100))
    if gap > 0:
        # The gap is split between neighbouring columns, so each side carries
        # half of it and the outer edges carry none.
        entries = columns.getColumns()
        for index, column in enumerate(entries):
            column.LeftMargin = 0 if index == 0 else gap // 2
            column.RightMargin = 0 if index == len(entries) - 1 else gap // 2
        columns.setColumns(entries)
    if rule:
        columns.SeparatorLineIsOn = True
        columns.SeparatorLineWidth = 10
        columns.SeparatorLineRelativeHeight = 100
    page.TextColumns = columns


def word_page_setup(document, theme, page_numbers, font, request=None):
    """Margins, and the page number that is always missing when it is absent."""
    pages = document.StyleFamilies.getByName('PageStyles')
    name = 'Standard' if pages.hasByName('Standard') else pages.getElementNames()[0]
    page = pages.getByName(name)
    page.LeftMargin = 2500
    page.RightMargin = 2500
    page.TopMargin = 2200
    page.BottomMargin = 2000
    columns = int((request or {}).get('columns', 1) or 1)
    if columns > 1:
        word_text_columns(
            document, page, columns,
            (request or {}).get('columnGapMm', 6),
            bool((request or {}).get('columnRule')),
        )
    if not page_numbers:
        return
    page.FooterIsOn = True
    footer = page.FooterText
    footer.String = ''
    cursor = footer.createTextCursor()
    field = document.createInstance('com.sun.star.text.TextField.PageNumber')
    field.SubType = uno.Enum('com.sun.star.text.PageNumberType', 'CURRENT')
    field.NumberingType = uno.getConstantByName('com.sun.star.style.NumberingType.ARABIC')
    footer.insertTextContent(cursor, field, False)
    cursor.gotoStart(False)
    cursor.gotoEnd(True)
    cursor.ParaAdjust = uno.Enum('com.sun.star.style.ParagraphAdjust', 'CENTER')
    cursor.CharHeight = 9.0
    cursor.CharHeightAsian = 9.0
    cursor.CharColor = int(theme['muted'])
    if font:
        cursor.CharFontName = font
        cursor.CharFontNameAsian = font


def utf16_length(value):
    """
    How far a UNO cursor has to travel to cover a string.

    Cursors move in UTF-16 units where Python counts code points, so anything
    outside the basic plane — an emoji, a rare Han character — is one short and
    the selection misses its last unit.
    """
    return len(str(value).encode('utf-16-le')) // 2


def word_paragraph(text, cursor, style_name, value, formatting=None, first=False, level=0):
    """One styled paragraph at the end of the document."""
    if not first:
        text.insertControlCharacter(
            cursor, uno.getConstantByName('com.sun.star.text.ControlCharacter.PARAGRAPH_BREAK'),
            False,
        )
    try:
        cursor.ParaStyleName = style_name
    except Exception:
        # A document that never defined that style still gets the text.
        cursor.ParaStyleName = 'Standard'
    # The list style defines ten levels; this is which one the paragraph sits
    # at. Without it a nested outline comes out flat, and the reader loses the
    # one thing the indentation was carrying.
    try:
        cursor.NumberingLevel = int(level)
    except Exception:
        pass
    text.insertString(cursor, value, False)
    if formatting and value:
        # Select what was just written; direct formatting left on the cursor
        # would otherwise bleed into every paragraph after it.
        cursor.goLeft(utf16_length(value), True)
        for key, item in formatting.items():
            setattr(cursor, key, item)
        cursor.gotoEnd(False)
    return cursor


def word_compose(document, request):
    if not document.supportsService('com.sun.star.text.TextDocument'):
        raise ValueError('The selected file is not a Word document')
    blocks = request.get('blocks') or []
    if not blocks:
        raise ValueError('blocks must contain at least one block')
    theme = WORD_THEMES.get(request.get('theme', 'azure'), WORD_THEMES['azure'])
    font = request.get('fontName') or ''
    cover = request.get('cover') or None

    word_apply_theme(document, theme, font)
    word_page_setup(document, theme, request.get('pageNumbers', True), font, request)

    text = document.Text
    # Composed, not appended: leftover paragraphs are exactly the half-finished
    # document this call exists to avoid.
    text.String = ''
    cursor = text.createTextCursor()
    cursor.gotoEnd(False)
    written = 0
    front_matter = False

    if cover:
        word_paragraph(text, cursor, 'Title', cover.get('title', ''), first=True)
        # A cover whose title sits against the top margin reads as page one of a
        # memo. Pushing the block down the page is what makes it a cover, and it
        # is direct formatting because the Title style is used elsewhere.
        cursor.ParaTopMargin = 6000
        if cover.get('subtitle'):
            word_paragraph(text, cursor, 'Subtitle', cover['subtitle'])
        if cover.get('byline'):
            word_paragraph(
                text, cursor, 'Standard', cover['byline'],
                {
                    'CharColor': int(theme['muted']),
                    'CharHeight': 10.5,
                    'CharHeightAsian': 10.5,
                    'ParaAdjust': uno.Enum('com.sun.star.style.ParagraphAdjust', 'CENTER'),
                    'ParaTopMargin': 900,
                },
            )
        front_matter = True

    index = None
    if request.get('tableOfContents'):
        index = document.createInstance('com.sun.star.text.ContentIndex')
        index.CreateFromOutline = True
        index.Title = request.get('tableOfContentsTitle') or 'Contents'
        if front_matter:
            text.insertControlCharacter(
                cursor,
                uno.getConstantByName('com.sun.star.text.ControlCharacter.PARAGRAPH_BREAK'),
                False,
            )
            cursor.ParaStyleName = 'Standard'
            cursor.BreakType = uno.Enum('com.sun.star.style.BreakType', 'PAGE_BEFORE')
        text.insertTextContent(cursor, index, False)
        cursor.gotoEnd(False)
        front_matter = True

    for position, block in enumerate(blocks):
        style_name = WORD_BLOCK_STYLES.get(block.get('style'), 'Standard')
        word_paragraph(
            text, cursor, style_name, block.get('text', ''),
            first=position == 0 and not front_matter,
            level=int(block.get('level', 0) or 0),
        )
        if position == 0 and front_matter:
            # The body starts on its own page, so the cover is a cover.
            cursor.BreakType = uno.Enum('com.sun.star.style.BreakType', 'PAGE_BEFORE')
        written += 1

    if index is not None:
        # The entries exist only now that the headings do.
        index.update()

    store_copy(document, request['outputPath'])
    return {'blocksWritten': written, 'theme': request.get('theme', 'azure')}


def word_add_footnotes(document, request):
    """
    Footnotes and endnotes, several at a time.

    A note in brackets in the running text is not a footnote: it does not
    number itself, does not sit at the foot of its page, and does not follow the
    text when it moves. This is the difference between a document that was
    written and one that was typed out.
    """
    if not document.supportsService('com.sun.star.text.TextDocument'):
        raise ValueError('The selected file is not a Word document')
    entries = request.get('footnotes') or []
    if not entries:
        raise ValueError('footnotes must contain at least one note')

    written = []
    for entry in entries:
        find = str(entry['find'])
        descriptor = document.createSearchDescriptor()
        descriptor.SearchString = find
        descriptor.SearchCaseSensitive = entry.get('matchCase', True) is not False
        matches = document.findAll(descriptor)
        occurrence = int(entry.get('occurrence', 1))
        if occurrence > matches.getCount():
            raise ValueError(
                f'Note occurrence {occurrence} for {find!r} was not found; '
                f'the document has {matches.getCount()} matches'
            )
        selected = matches.getByIndex(occurrence - 1)
        note = document.createInstance(
            'com.sun.star.text.Endnote' if entry.get('kind') == 'endnote'
            else 'com.sun.star.text.Footnote'
        )
        label = str(entry.get('label', '') or '')
        if label:
            # An empty label is what keeps the note automatically numbered.
            note.Label = label
        # Anchored after the match, where a reader expects the mark.
        selected.Text.insertTextContent(selected.End, note, False)
        note.insertString(note.createTextCursor(), str(entry.get('text', '')), False)
        written.append({'find': find, 'kind': entry.get('kind') or 'footnote'})

    store_copy(document, request['outputPath'])
    return {'notesWritten': len(written), 'notes': written}


def word_format_text(document, request):
    if not document.supportsService('com.sun.star.text.TextDocument'):
        raise ValueError('The selected file is not a Word document')
    descriptor = document.createSearchDescriptor()
    descriptor.SearchString = request['find']
    descriptor.SearchCaseSensitive = True
    found = document.findAll(descriptor)
    matched = int(found.getCount())
    text_color = color_number(request.get('textColor'))
    highlight = color_number(request.get('highlightColor'))
    alignment = request.get('alignment')
    for index in range(matched):
        selection = found.getByIndex(index)
        if 'bold' in request and request['bold'] is not None:
            selection.CharWeight = 150.0 if request['bold'] else 100.0
        if 'italic' in request and request['italic'] is not None:
            selection.CharPosture = uno.Enum(
                'com.sun.star.awt.FontSlant', 'ITALIC' if request['italic'] else 'NONE'
            )
        if 'underline' in request and request['underline'] is not None:
            selection.CharUnderline = 1 if request['underline'] else 0
        if request.get('fontName'):
            selection.CharFontName = request['fontName']
        if request.get('fontSize'):
            selection.CharHeight = float(request['fontSize'])
        if text_color is not None:
            selection.CharColor = text_color
        if highlight is not None:
            selection.CharBackColor = highlight
        if alignment:
            # Alignment belongs to the paragraph the match sits in.
            selection.ParaAdjust = uno.Enum(
                'com.sun.star.style.ParagraphAdjust',
                'BLOCK' if alignment == 'justify' else alignment.upper(),
            )
    store_copy(document, request['outputPath'])
    return {'matched': matched}


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


"""
Caption labels that have a conventional counter name.

The label is what the reader sees; the counter's name is an expression
identifier. A non-ASCII identifier silently evaluates to nothing, so a caption
labelled 图 came out with an empty gap where its number belongs — and an empty
gap is worse than no caption, because the document looks finished.
"""
CAPTION_SEQUENCES = {
    '图': 'Figure', '图表': 'Chart', '表': 'Table', '表格': 'Table', '公式': 'Equation',
}


def sequence_name(label):
    """An ASCII counter name for a label, distinct per label so counts do not merge."""
    known = CAPTION_SEQUENCES.get(label)
    if known:
        return known
    ascii_name = re.sub(r'[^A-Za-z0-9]', '', label)
    if ascii_name:
        return ascii_name
    return 'Seq' + hashlib.sha1(label.encode('utf-8')).hexdigest()[:8]


def sequence_field(document, label):
    """
    The counter behind `图 1`, `图 2`.

    A typed digit does not renumber when a figure is inserted above it, and a
    document whose figures and numbers disagree is worse than one with no
    captions at all. Word calls this a SEQ field; LibreOffice reaches it through
    a number-range field master, which has to exist before a field can use it.
    """
    master_name = f'com.sun.star.text.FieldMaster.SetExpression.{label}'
    masters = document.getTextFieldMasters()
    if masters.hasByName(master_name):
        master = masters.getByName(master_name)
    else:
        master = document.createInstance('com.sun.star.text.FieldMaster.SetExpression')
        master.SubType = uno.getConstantByName(
            'com.sun.star.text.SetVariableType.SEQUENCE'
        )
        master.Name = label
    field = document.createInstance('com.sun.star.text.TextField.SetExpression')
    field.SubType = uno.getConstantByName('com.sun.star.text.SetVariableType.SEQUENCE')
    field.NumberingType = uno.getConstantByName('com.sun.star.style.NumberingType.ARABIC')
    field.Content = f'{label}+1'
    field.attachTextFieldMaster(master)
    return field


def word_caption(document, text, cursor, caption, label):
    """A caption paragraph under whatever was just inserted."""
    paragraph_break = uno.getConstantByName(
        'com.sun.star.text.ControlCharacter.PARAGRAPH_BREAK'
    )
    text.insertControlCharacter(cursor, paragraph_break, False)
    styles = document.StyleFamilies.getByName('ParagraphStyles')
    if not styles.hasByName('Caption'):
        try:
            styles.insertByName(
                'Caption', document.createInstance('com.sun.star.style.ParagraphStyle')
            )
        except Exception:
            pass
    try:
        cursor.ParaStyleName = 'Caption'
    except Exception:
        cursor.ParaStyleName = 'Standard'
    # "图 " then the counter then " 说明", so the label reads in the document's
    # own language while the number stays a field.
    # The label is written as plain text and the number as a field, so the
    # series reads in the document's own language while still renumbering.
    text.insertString(cursor, f'{label} ', False)
    text.insertTextContent(cursor, sequence_field(document, sequence_name(label)), False)
    text.insertString(cursor, f' {caption}', False)


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
    caption = str(request.get('caption', '') or '')
    if caption:
        word_caption(document, text, cursor, caption, str(request.get('captionLabel') or 'Figure'))
        # A field exports with whatever result it last computed, and one that
        # has never been computed exports empty: Word would show the caption
        # with a gap until the reader pressed F9.
        try:
            document.getTextFields().refresh()
        except Exception:
            pass
    store_copy(document, request['outputPath'])
    return {'imageInserted': True, 'captioned': bool(caption)}


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


"""
Table looks.

The same reasoning as the deck themes: a model that has to compose a header
fill, a number format, borders, banding, widths and a freeze out of separate
calls gets it wrong or gives up half way. One call, one finished table.
"""
EXCEL_TABLE_THEMES = {
    'azure': {'header': 0x1F4E79, 'headerText': 0xFFFFFF, 'band': 0xEFF5FB, 'line': 0xB7C9D8},
    'slate': {'header': 0x334155, 'headerText': 0xFFFFFF, 'band': 0xF1F5F9, 'line': 0xCBD5E1},
    'forest': {'header': 0x1B4438, 'headerText': 0xFFFFFF, 'band': 0xEDF6F1, 'line': 0xBBD6C8},
    'plum': {'header': 0x5B2A56, 'headerText': 0xFFFFFF, 'band': 0xF7EFF6, 'line': 0xD9C2D6},
    'mono': {'header': 0x111111, 'headerText': 0xFFFFFF, 'band': 0xF4F4F4, 'line': 0xCCCCCC},
}


def excel_compose_table(document, request):
    sheet_name, sheet = spreadsheet(document, request.get('sheet', ''))
    theme = EXCEL_TABLE_THEMES.get(request.get('theme', 'azure'), EXCEL_TABLE_THEMES['azure'])
    start = sheet.getCellRangeByName(request.get('startCell', 'A1')).getCellAddress()
    headers = request.get('headers') or []
    rows = request.get('rows') or []
    formats = request.get('columnFormats') or []
    title = request.get('title', '')
    column_count = max(len(headers), max((len(row) for row in rows), default=0))
    if column_count == 0:
        raise ValueError('A table needs at least one column')

    row_cursor = start.Row
    if title:
        title_range = sheet.getCellRangeByPosition(
            start.Column, row_cursor, start.Column + column_count - 1, row_cursor
        )
        title_range.merge(True)
        title_cell = sheet.getCellByPosition(start.Column, row_cursor)
        title_cell.String = title
        title_cell.CharHeight = 15.0
        title_cell.CharWeight = 150.0
        title_cell.CharColor = theme['header']
        row_cursor += 2

    header_row = row_cursor
    for index, header in enumerate(headers):
        cell = sheet.getCellByPosition(start.Column + index, header_row)
        cell.String = '' if header is None else str(header)
    header_range = sheet.getCellRangeByPosition(
        start.Column, header_row, start.Column + column_count - 1, header_row
    )
    header_range.CellBackColor = theme['header']
    header_range.CharColor = theme['headerText']
    header_range.CharWeight = 150.0
    header_range.HoriJustify = uno.Enum('com.sun.star.table.CellHoriJustify', 'CENTER')
    header_range.VertJustify = uno.Enum('com.sun.star.table.CellVertJustify', 'CENTER')
    header_range.IsTextWrapped = True

    first_data_row = header_row + 1
    for row_offset, row in enumerate(rows):
        for column_offset in range(column_count):
            value = row[column_offset] if column_offset < len(row) else None
            cell = sheet.getCellByPosition(
                start.Column + column_offset, first_data_row + row_offset
            )
            if value is None:
                cell.String = ''
            elif isinstance(value, bool):
                cell.Value = 1 if value else 0
            elif isinstance(value, (int, float)):
                cell.Value = float(value)
            elif str(value).startswith('='):
                cell.Formula = str(value)
            else:
                cell.String = str(value)
        if request.get('bandedRows', True) and row_offset % 2 == 1:
            band = sheet.getCellRangeByPosition(
                start.Column, first_data_row + row_offset,
                start.Column + column_count - 1, first_data_row + row_offset,
            )
            band.CellBackColor = theme['band']

    # A table with no rows is its header. `max(len(rows), 1)` used to claim one
    # row anyway, so borders and number formats were drawn across a row that
    # does not exist.
    last_row = first_data_row + len(rows) - 1 if rows else header_row
    if request.get('totalsRow') and rows:
        last_row += 1
        total_cell = sheet.getCellByPosition(start.Column, last_row)
        total_cell.String = request.get('totalsLabel') or 'Total'
        for column_offset in range(1, column_count):
            code = formats[column_offset] if column_offset < len(formats) else ''
            if not code:
                continue
            # A percentage column holds ratios. Three months at 62% do not add
            # up to 187%, and a total nobody can defend is worse than none.
            if '%' in code:
                continue
            letter = column_name(start.Column + column_offset)
            cell = sheet.getCellByPosition(start.Column + column_offset, last_row)
            cell.Formula = (
                f'=SUM({letter}{first_data_row + 1}:{letter}{last_row})'
            )
        totals = sheet.getCellRangeByPosition(
            start.Column, last_row, start.Column + column_count - 1, last_row
        )
        totals.CharWeight = 150.0
        totals.TopBorder = cell_border_line(52)

    # Number formats are what turn a column of digits into money or a percentage.
    for column_offset, code in enumerate(formats[:column_count] if rows else []):
        if not code:
            continue
        column = sheet.getCellRangeByPosition(
            start.Column + column_offset, first_data_row,
            start.Column + column_offset, last_row,
        )
        column.NumberFormat = number_format_key(document, code)
        column.HoriJustify = uno.Enum('com.sun.star.table.CellHoriJustify', 'RIGHT')

    body = sheet.getCellRangeByPosition(
        start.Column, header_row, start.Column + column_count - 1, last_row
    )
    apply_cell_borders(body, 'all')
    body.Columns.OptimalWidth = True
    document.calculateAll()

    store_copy(document, request['outputPath'])
    return {
        'sheet': sheet_name,
        'range': range_name(body.getRangeAddress()),
        'rowsWritten': len(rows),
        'columns': column_count,
    }


def excel_add_comments(document, request):
    """
    Notes on cells, several at a time.

    Reviewing a sheet means marking every place that needs attention, and one
    call per note would be one approval and one engine start per note. The
    review is a single action to the user, so it is a single call here.
    """
    sheet_name, sheet = spreadsheet(document, request.get('sheet', ''))
    annotations = sheet.getAnnotations()
    entries = request.get('comments') or []
    if not entries:
        raise ValueError('comments must contain at least one note')

    written = []
    for entry in entries:
        reference = str(entry['cell'])
        address = sheet.getCellRangeByName(reference).getCellAddress()
        # A cell holds one note. Inserting beside the old one stacks two boxes
        # on the same cell, which is not what "comment on this cell" means.
        for index in range(annotations.getCount() - 1, -1, -1):
            position = annotations.getByIndex(index).Position
            if (
                position.Sheet == address.Sheet
                and position.Column == address.Column
                and position.Row == address.Row
            ):
                annotations.removeByIndex(index)
        annotations.insertNew(address, str(entry.get('text', '')))
        if entry.get('visible'):
            annotations.getByIndex(annotations.getCount() - 1).IsVisible = True
        written.append(reference)

    store_copy(document, request['outputPath'])
    return {'sheet': sheet_name, 'cells': written, 'commentsWritten': len(written)}


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
    if 'italic' in request and request['italic'] is not None:
        selected.CharPosture = uno.Enum(
            'com.sun.star.awt.FontSlant', 'ITALIC' if request['italic'] else 'NONE'
        )
    font_name = request.get('fontName')
    if font_name:
        selected.CharFontName = font_name
    font_size = request.get('fontSize')
    if font_size:
        selected.CharHeight = float(font_size)
    alignment = request.get('horizontalAlignment')
    if alignment:
        selected.HoriJustify = uno.Enum(
            'com.sun.star.table.CellHoriJustify', alignment.upper()
        )
    vertical = request.get('verticalAlignment')
    if vertical:
        # VertJustify takes the CellVertJustify *enum*; CellVertJustify2 is a
        # constant group and raises "enum ... is unknown" when used as one.
        selected.VertJustify = uno.Enum(
            'com.sun.star.table.CellVertJustify',
            'CENTER' if vertical == 'middle' else vertical.upper(),
        )
    if 'wrapText' in request and request['wrapText'] is not None:
        selected.IsTextWrapped = bool(request['wrapText'])
    number_format = request.get('numberFormat')
    if number_format:
        selected.NumberFormat = number_format_key(document, number_format)
    borders = request.get('borders')
    if borders:
        apply_cell_borders(selected, borders)
    if request.get('merge') is True:
        selected.merge(True)
    elif request.get('merge') is False:
        selected.merge(False)
    if 'optimalWidth' in request and request['optimalWidth'] is not None:
        selected.Columns.OptimalWidth = bool(request['optimalWidth'])
    formatted_range = range_name(selected.getRangeAddress())
    store_copy(document, request['outputPath'])
    return {'formattedRange': formatted_range}


def number_format_key(document, format_code):
    """Format codes live in the document's own table; add the code if it is new."""
    formats = document.getNumberFormats()
    locale = uno.createUnoStruct('com.sun.star.lang.Locale')
    key = formats.queryKey(format_code, locale, False)
    if key == -1:
        key = formats.addNew(format_code, locale)
    return key


def cell_border_line(width):
    line = uno.createUnoStruct('com.sun.star.table.BorderLine2')
    line.LineStyle = uno.getConstantByName('com.sun.star.table.BorderLineStyle.SOLID')
    line.LineWidth = width
    line.Color = 0x9AA5B1
    return line


def apply_cell_borders(selected, borders):
    """`all` draws every edge, `outline` only the range's own frame."""
    width = 0 if borders == 'none' else 26
    line = cell_border_line(width)
    for edge in ('TopBorder', 'BottomBorder', 'LeftBorder', 'RightBorder'):
        setattr(selected, edge, line)
    inner = uno.createUnoStruct('com.sun.star.table.TableBorder2')
    inner.IsHorizontalLineValid = True
    inner.IsVerticalLineValid = True
    if borders == 'all':
        inner.HorizontalLine = line
        inner.VerticalLine = line
    else:
        blank = cell_border_line(0)
        inner.HorizontalLine = blank
        inner.VerticalLine = blank
    selected.TableBorder2 = inner


def excel_freeze_panes(document, request):
    sheet_name, sheet = spreadsheet(document, request.get('sheet', ''))
    rows = int(request.get('rows', 0) or 0)
    columns = int(request.get('columns', 0) or 0)
    controller = document.getCurrentController()
    controller.setActiveSheet(sheet)
    # Freezing is a view property, and it travels with the saved document.
    controller.freezeAtPosition(columns, rows)
    store_copy(document, request['outputPath'])
    return {'sheet': sheet_name, 'rows': rows, 'columns': columns}


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


"""
Chart frame, in 1/100 mm: 160x90mm for a short range, wider for a long one.

The engine clips categories that do not fit rather than compressing them:
measured against the real thing, a 160mm frame drew six of eighteen and a 288mm
one drew twelve, and the rest were gone with nothing in the file to say so. So
the frame grows with what it has to draw. The ceiling is where a chart stops
being one a person can read at all, and a pivot nested deep enough to reach it
wants its own chart of the totals rather than a wider one of every leaf.
"""
CHART_WIDTH = 16000
CHART_HEIGHT = 9000
CHART_WIDTH_PER_CATEGORY = 2400
CHART_MAX_WIDTH = 40000


def add_sheet_chart(
    sheet, address, chart_type, requested_name, title,
    column_headers=True, row_headers=True,
):
    """Draw one chart beside `address`, and return the name it ended up with.

    `column_headers` and `row_headers` are the engine's own two flags, in its
    own order: the topmost row and the leftmost column of the charted range.
    """
    charts = sheet.Charts
    chart_name = unique_chart_name(charts, requested_name or title or 'Chart')
    # Beside the data, not on top of it. A fixed corner puts every chart over
    # the table it describes, and the user has to drag it off before reading
    # either.
    anchor = sheet.getCellByPosition(address.EndColumn + 1, address.StartRow)
    rectangle = uno.createUnoStruct('com.sun.star.awt.Rectangle')
    rectangle.X = int(anchor.Position.X) + 400
    rectangle.Y = int(anchor.Position.Y)
    # Wide enough for what it has to draw. A fixed frame fits a handful of
    # categories; a pivot nested two fields deep with two measures has eighteen,
    # and everything past the sixth was drawn outside the frame — gone from the
    # chart, with nothing in the file to say so. The floor keeps a two-row chart
    # the size it always was, and the ceiling stops a long pivot from producing
    # a chart measured in metres.
    categories = address.EndRow - address.StartRow + 1
    rectangle.Width = min(
        max(CHART_WIDTH, categories * CHART_WIDTH_PER_CATEGORY), CHART_MAX_WIDTH
    )
    rectangle.Height = CHART_HEIGHT
    charts.addNewByName(chart_name, rectangle, (address,), column_headers, row_headers)
    chart_document = charts.getByName(chart_name).EmbeddedObject
    diagram = chart_document.createInstance(CHART_DIAGRAMS[chart_type])
    if chart_type in ('column', 'bar'):
        # Vertical means the bars run horizontally, so a column chart is False.
        diagram.Vertical = chart_type == 'bar'
    chart_document.Diagram = diagram
    if title:
        chart_document.Title.String = title
    return chart_name


def excel_create_chart(document, request):
    _sheet_name, sheet = spreadsheet(document, request.get('sheet', ''))
    selected = sheet.getCellRangeByName(request['dataRange'])
    chart_name = add_sheet_chart(
        sheet,
        selected.getRangeAddress(),
        request['chartType'],
        request.get('chartName', ''),
        request.get('title', ''),
        # In the engine's order: the topmost row first, the leftmost column
        # second. These were the other way round, which only showed when a
        # caller turned one of them off — both default to true.
        request.get('firstRowLabels', True) is not False,
        request.get('firstColumnLabels', True) is not False,
    )
    store_copy(document, request['outputPath'])
    return {'chartName': chart_name}


def data_pilot_field_index(fields, requested_name):
    """Where the field sits among the source columns, which is the order the
    stored definition lists them in."""
    for index in range(fields.getCount()):
        if str(fields.getByIndex(index).Name) == requested_name:
            return index
    return -1


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


def pivot_orientation(area):
    return uno.Enum('com.sun.star.sheet.DataPilotFieldOrientation', area)


def pivot_rank_by(row_field, measure_name, direction, top_n):
    """Order and cut the first row field by the first measure.

    Both are properties of the row field rather than of the table, and both
    name the measure by its *source* field name, not by the header the engine
    writes above the column.
    """
    if direction:
        sort_info = uno.createUnoStruct('com.sun.star.sheet.DataPilotFieldSortInfo')
        sort_info.Field = measure_name
        sort_info.IsAscending = direction == 'ascending'
        sort_info.Mode = uno.getConstantByName(
            'com.sun.star.sheet.DataPilotFieldSortMode.DATA'
        )
        row_field.SortInfo = sort_info
    if top_n:
        auto_show = uno.createUnoStruct('com.sun.star.sheet.DataPilotFieldAutoShowInfo')
        auto_show.IsEnabled = True
        auto_show.ShowItemsMode = uno.getConstantByName(
            'com.sun.star.sheet.DataPilotFieldShowItemsMode.FROM_TOP'
        )
        auto_show.ItemCount = top_n
        auto_show.DataField = measure_name
        row_field.AutoShowInfo = auto_show


def persist_pivot_ranking(output_path, field_index, top_n):
    """Write the ranking into the pivot's own definition.

    The engine applies AutoShow while it builds the table and then drops it on
    the way out: the cells it writes are ranked, the definition it stores is
    not. So the first refresh in Excel — or the first reopen in LibreOffice,
    which is what this app's own PDF export does — brings the ranked-out rows
    back, and the file stops agreeing with what the operation reported.

    OOXML has the two attributes for it, and the engine reads them back. The
    field is addressed by its column in the source range, which is the order
    `pivotFields` is written in, so this lands on the field that was ranked.
    Only for the format that needs it: ODF stores AutoShow properly.
    """
    if not output_path.lower().endswith('.xlsx'):
        return
    ranking = (
        f' autoShow="1" topAutoShow="1" rankBy="0" itemPageCount="{int(top_n)}"'
    )
    staged = f'{output_path}.ranking'
    with zipfile.ZipFile(output_path) as source:
        entries = [(item, source.read(item.filename)) for item in source.infolist()]
    rewrote = False
    with zipfile.ZipFile(staged, 'w', zipfile.ZIP_DEFLATED) as target:
        for item, data in entries:
            if re.match(r'xl/pivotTables/pivotTable\d+\.xml$', item.filename):
                seen = [0]

                def rank(match):
                    tag = match.group(0)
                    at = seen[0]
                    seen[0] += 1
                    if at != field_index:
                        return tag
                    if tag.endswith('/>'):
                        return tag[:-2] + ranking + '/>'
                    return tag[:-1] + ranking + '>'

                # `<pivotFields>` is the container and wears the same prefix,
                # so the name has to end here or the ranking lands on the list
                # rather than on a field in it.
                text, count = re.subn(
                    r'<pivotField(?=[ />])[^>]*?/?>', rank, data.decode('utf-8')
                )
                if count > field_index:
                    data = text.encode('utf-8')
                    rewrote = True
            target.writestr(item, data)
    if rewrote:
        os.replace(staged, output_path)
    else:
        os.remove(staged)


def pivot_chart_range(sheet, output_address, filter_fields, column_fields, measure_count):
    """The part of a pivot's output that is worth plotting.

    `getOutputRange()` covers the whole thing: the page-field rows the engine
    stacks above the table, and the grand total below it. Plotting either is
    wrong in a way that is obvious on sight — a grand total is one bar taller
    than every category it sums, and a page field is a category with no value.

    The engine's own layout, measured against it rather than assumed:

        年份   - all -        <- one row per page field
                              <- then a blank one
                    季度      <- one label row per column field
        地区   Data   Q1  Q2  总计
        ...
        总计                  <- one grand total row per measure

    A second measure moves the measures themselves into the row area, so the
    grand total is one row per measure rather than a single row either way.
    """
    start_row = output_address.StartRow
    if filter_fields:
        start_row += len(filter_fields) + 1
    start_row += len(column_fields)
    end_row = output_address.EndRow
    end_row -= measure_count
    end_column = output_address.EndColumn
    if column_fields:
        end_column -= 1
    if end_row <= start_row or end_column <= output_address.StartColumn:
        return None
    return sheet.getCellRangeByPosition(
        output_address.StartColumn, start_row, end_column, end_row,
    ).getRangeAddress()


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
    filter_fields = list(request.get('filterFields') or [])
    # The engine writes its own furniture, in English. A Chinese report with
    # "Total Result" down the middle reads as generated by something that was
    # not paying attention, and the filter button is a separate English "Filter"
    # cell above everything — page fields draw their own dropdowns without it.
    try:
        descriptor.ShowFilterButton = False
    except Exception:
        pass
    grand_total_label = request.get('grandTotalLabel', '')
    if grand_total_label:
        try:
            descriptor.GrandTotalName = str(grand_total_label)
        except Exception:
            pass
    fields = descriptor.getDataPilotFields()
    row_fields = [data_pilot_field(fields, name) for name in request['rowFields']]
    for field in row_fields:
        field.Orientation = pivot_orientation('ROW')
    column_fields = list(request.get('columnFields') or [])
    for name in column_fields:
        data_pilot_field(fields, name).Orientation = pivot_orientation('COLUMN')
    for name in filter_fields:
        data_pilot_field(fields, name).Orientation = pivot_orientation('PAGE')
    measures = request['dataFields']
    for measure in measures:
        data_field = data_pilot_field(fields, measure['field'])
        data_field.Orientation = pivot_orientation('DATA')
        data_field.Function = uno.Enum(
            'com.sun.star.sheet.GeneralFunction', measure['function']
        )
        label = measure.get('label', '')
        if label:
            data_field.setName(str(label))
    top_n = int(request.get('topN', 0) or 0)
    pivot_rank_by(
        row_fields[0],
        measures[0]['field'],
        request.get('sortByData', ''),
        top_n,
    )
    ranked_field_index = data_pilot_field_index(fields, request['rowFields'][0])
    output_address = destination_sheet.getCellRangeByName(
        request['destinationCell']
    ).getCellAddress()
    pivot_name = unique_pivot_name(tables, request.get('pivotName', ''))
    tables.insertNewByName(pivot_name, output_address, descriptor)
    pivot_table = tables.getByName(pivot_name)
    output_range = pivot_table.getOutputRange()
    output = destination_sheet.getCellRangeByName(range_name(output_range))
    number_format = request.get('numberFormat', '')
    if number_format:
        output.NumberFormat = number_format_key(document, number_format)
    if request.get('optimalWidth', True) is not False:
        output.Columns.OptimalWidth = True
    chart_type = request.get('chartType', '')
    chart_name = ''
    if chart_type:
        chart_address = pivot_chart_range(
            destination_sheet, output_range, filter_fields, column_fields, len(measures)
        )
        if chart_address is not None:
            chart_name = add_sheet_chart(
                destination_sheet,
                chart_address,
                chart_type,
                request.get('chartName', ''),
                request.get('chartTitle', ''),
            )
    store_copy(document, request['outputPath'])
    if top_n and ranked_field_index >= 0:
        persist_pivot_ranking(request['outputPath'], ranked_field_index, top_n)
    return {
        'pivotName': pivot_name,
        'destinationSheet': destination_sheet_name,
        'outputRange': range_name(output_range),
        'chartName': chart_name,
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


MAGIES_THEME_PROPERTY = 'MagiesTheme'
MAGIES_FOOTER_PROPERTY = 'MagiesFooter'


def user_defined_properties(document):
    try:
        return document.DocumentProperties.UserDefinedProperties
    except Exception:
        return None


def remember_deck_style(document, theme_name, footer):
    """
    Record how the deck was composed, inside the deck.

    A deck is composed once and then edited, and a slide added afterwards has to
    look like the one it joins. The only place that survives closing the file is
    the document itself, and a custom property is the one slot both LibreOffice
    and PowerPoint carry through a round trip.
    """
    properties = user_defined_properties(document)
    if properties is None:
        return
    removable = uno.getConstantByName('com.sun.star.beans.PropertyAttribute.REMOVABLE')
    for name, value in (
        (MAGIES_THEME_PROPERTY, str(theme_name or '')),
        (MAGIES_FOOTER_PROPERTY, str(footer or '')),
    ):
        try:
            properties.addProperty(name, removable, value)
        except Exception:
            # Already there from an earlier compose; the value still has to move.
            try:
                properties.setPropertyValue(name, value)
            except Exception:
                pass


def remembered_deck_style(document):
    """The theme and footer a previous compose left, or empty strings."""
    properties = user_defined_properties(document)
    if properties is None:
        return '', ''

    def read(name):
        try:
            return str(properties.getPropertyValue(name) or '')
        except Exception:
            return ''

    return read(MAGIES_THEME_PROPERTY), read(MAGIES_FOOTER_PROPERTY)


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

    remembered_theme, remembered_footer = remembered_deck_style(document)
    theme_name = request.get('theme') or remembered_theme
    if theme_name in PRESENTATION_THEMES:
        # Composed by us, so the new slide joins the deck rather than sitting in
        # it. A deck we never composed keeps its own look below: applying this
        # theme to one slide of someone's corporate template would be worse than
        # the plain slide it replaces.
        theme = PRESENTATION_THEMES[theme_name]
        font = request.get('fontName') or ''
        geometry = (page_width, page_height)
        layout = request.get('layout') or 'bullets'
        compose_slide(
            document, slide,
            {'layout': layout, 'title': title, 'body': list(body)},
            theme, font, geometry,
        )
        if layout not in ('title', 'closing'):
            slide_footer(
                document, slide, theme, font, geometry,
                insert_index + 1, request.get('footer') or remembered_footer,
            )
        store_copy(document, request['outputPath'])
        return {
            'slideNumber': insert_index + 1,
            'slidesTotal': pages.getCount(),
            'theme': theme_name,
        }

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


def shape_text_cursor(shape):
    """A cursor over a shape's whole text, or None when it holds no text."""
    if not hasattr(shape, 'createTextCursor'):
        return None
    cursor = shape.createTextCursor()
    cursor.gotoStart(False)
    cursor.gotoEnd(True)
    return cursor


def slide_shapes_for_target(slide, target):
    """
    Which shapes a format request means.

    A deck made by an outline tool uses real placeholders; one Magies built with
    office_presentation_add_slide uses plain text shapes, where the first shape
    is the title and the rest are the body. Both have to work, or formatting is
    a no-op on exactly the decks this app generates.
    """
    shapes = [slide.getByIndex(index) for index in range(slide.getCount())]
    text_shapes = [shape for shape in shapes if hasattr(shape, 'createTextCursor')]
    if target == 'all':
        return text_shapes
    titles = [
        shape for shape in text_shapes
        if shape.supportsService('com.sun.star.presentation.TitleTextShape')
    ]
    if target == 'title':
        return titles if titles else text_shapes[:1]
    bodies = [
        shape for shape in text_shapes
        if shape.supportsService('com.sun.star.presentation.OutlinerShape')
        or shape.supportsService('com.sun.star.presentation.SubtitleShape')
    ]
    if bodies:
        return bodies
    return text_shapes[1:] if titles == [] else [
        shape for shape in text_shapes if shape not in titles
    ]


def presentation_format_text(document, request):
    pages = presentation(document)
    slide_number = int(request.get('slideNumber') or 0)
    if slide_number == 0:
        slides = [pages.getByIndex(index) for index in range(pages.getCount())]
    else:
        slides = [presentation_slide_by_number(pages, slide_number)]
    target = request.get('target', 'all')
    text_color = color_number(request.get('textColor'))
    alignment = request.get('alignment')
    formatted = 0
    for slide in slides:
        for shape in slide_shapes_for_target(slide, target):
            cursor = shape_text_cursor(shape)
            if cursor is None:
                continue
            if request.get('fontName'):
                cursor.CharFontName = request['fontName']
            if request.get('fontSize'):
                cursor.CharHeight = float(request['fontSize'])
            if 'bold' in request and request['bold'] is not None:
                cursor.CharWeight = 150.0 if request['bold'] else 100.0
            if 'italic' in request and request['italic'] is not None:
                cursor.CharPosture = uno.Enum(
                    'com.sun.star.awt.FontSlant', 'ITALIC' if request['italic'] else 'NONE'
                )
            if text_color is not None:
                cursor.CharColor = text_color
                # Themed text ignores a direct colour until the theme link is cut.
                try:
                    cursor.CharColorTheme = -1
                except Exception:
                    pass
            if alignment:
                cursor.ParaAdjust = uno.Enum(
                    'com.sun.star.style.ParagraphAdjust',
                    'BLOCK' if alignment == 'justify' else alignment.upper(),
                )
            formatted += 1
    store_copy(document, request['outputPath'])
    return {'shapesFormatted': formatted}


def background_fill(document, color, gradient_to):
    fill = document.createInstance('com.sun.star.drawing.Background')
    if gradient_to is None:
        fill.FillStyle = uno.Enum('com.sun.star.drawing.FillStyle', 'SOLID')
        fill.FillColor = color
        return fill
    gradient = uno.createUnoStruct('com.sun.star.awt.Gradient')
    gradient.Style = uno.Enum('com.sun.star.awt.GradientStyle', 'LINEAR')
    gradient.StartColor = color
    gradient.EndColor = gradient_to
    gradient.Angle = 450
    gradient.Border = 0
    gradient.XOffset = 0
    gradient.YOffset = 0
    gradient.StartIntensity = 100
    gradient.EndIntensity = 100
    gradient.StepCount = 0
    fill.FillStyle = uno.Enum('com.sun.star.drawing.FillStyle', 'GRADIENT')
    fill.FillGradient = gradient
    return fill


def presentation_apply_theme(document, request):
    """
    Give a deck somebody else made one of our looks, through its master.

    Painting every slide would leave anything added afterwards — by us or by
    PowerPoint — on the old white background, and the deck would drift apart
    again the first time it is edited. A master is what a deck inherits from,
    so it is where a new look belongs. Slides carrying a background of their own
    keep overriding it, which is why those are cleared as well.
    """
    pages = presentation(document)
    theme_name = request.get('theme', 'azure')
    theme = PRESENTATION_THEMES.get(theme_name, PRESENTATION_THEMES['azure'])
    font = request.get('fontName') or ''

    masters = document.getMasterPages()
    for index in range(masters.getCount()):
        masters.getByIndex(index).Background = background_fill(
            document, theme['background'], theme['gradient']
        )

    geometry = (int(pages.getByIndex(0).Width), int(pages.getByIndex(0).Height))
    restyled = 0
    for index in range(pages.getCount()):
        slide = pages.getByIndex(index)
        # Inherit from the master rather than sit on an older colour.
        try:
            slide.Background = None
        except Exception:
            pass
        for shape_index in range(slide.getCount()):
            cursor = shape_text_cursor(slide.getByIndex(shape_index))
            if cursor is None:
                continue
            # The first text shape on a slide is its heading, and a heading in
            # body colour reads as a paragraph that happens to be large.
            cursor.CharColor = int(theme['title'] if shape_index == 0 else theme['body'])
            if font:
                cursor.CharFontName = font
        if request.get('footer'):
            slide_footer(
                document, slide, theme, font, geometry, index + 1, request['footer'],
            )
        restyled += 1

    remember_deck_style(document, theme_name, request.get('footer', ''))
    store_copy(document, request['outputPath'])
    return {'slidesRestyled': restyled, 'theme': theme_name}


def presentation_set_background(document, request):
    pages = presentation(document)
    slide_number = int(request.get('slideNumber') or 0)
    if slide_number == 0:
        slides = [pages.getByIndex(index) for index in range(pages.getCount())]
    else:
        slides = [presentation_slide_by_number(pages, slide_number)]
    color = color_number(request['color'])
    gradient_to = color_number(request.get('gradientTo'))
    painted = 0
    for slide in slides:
        slide.Background = background_fill(document, color, gradient_to)
        painted += 1
    store_copy(document, request['outputPath'])
    return {'slidesPainted': painted}


"""
Deck themes.

A model asked to "make it look good" through a dozen styling calls produces a
different half-finished mess every time. Giving it a small set of finished looks
and one call that applies them is what turns an outline into a deck: the model
does what it is good at (the words) and the theme does the rest.

Colours are integers because that is what UNO fill and character properties take.
"""
PRESENTATION_THEMES = {
    'azure': {
        'background': 0x0F2B46, 'gradient': 0x1F4E79,
        'title': 0xFFFFFF, 'body': 0xD6E4F0, 'accent': 0x4FA3E3, 'muted': 0x8FA9C2,
        'series': (0x4FA3E3, 0x86C7F0, 0xF2B441, 0xB8D4E8),
    },
    'midnight': {
        'background': 0x11121A, 'gradient': 0x232744,
        'title': 0xFFFFFF, 'body': 0xC9CBE0, 'accent': 0x8B7BF7, 'muted': 0x7A7D96,
        'series': (0x8B7BF7, 0xB5A8FF, 0x4ECBB0, 0xE0DAFF),
    },
    'sand': {
        'background': 0xFBF7F0, 'gradient': 0xF1E7D6,
        'title': 0x3A2E21, 'body': 0x5B4B39, 'accent': 0xC98A3B, 'muted': 0x9A8672,
        'series': (0xC98A3B, 0xE0B472, 0x6F7F5C, 0xD9C7A8),
    },
    'forest': {
        'background': 0x0E2A22, 'gradient': 0x1B4438,
        'title': 0xFFFFFF, 'body': 0xCDE5DA, 'accent': 0x53C08A, 'muted': 0x86A79A,
        'series': (0x53C08A, 0x8FDCB6, 0xE8C168, 0xC4E6D6),
    },
    'mono': {
        'background': 0xFFFFFF, 'gradient': 0xF2F2F2,
        'title': 0x111111, 'body': 0x3D3D3D, 'accent': 0x111111, 'muted': 0x8A8A8A,
        'series': (0x111111, 0x666666, 0xA0A0A0, 0xD0D0D0),
    },
}


def text_weight(text):
    """
    Roughly how much width a string wants, in half-widths.

    A CJK glyph occupies a full em where a Latin letter occupies about half, so
    counting characters says nothing about whether a headline fits. Fifteen
    characters of English is a short title; fifteen of Chinese is twice the box.
    """
    return sum(2 if ord(character) > 0x2E80 else 1 for character in str(text))


def fitted_size(text, largest, smallest, budget):
    """Step a headline down when it would overrun the box it was given."""
    weight = text_weight(text)
    if weight <= budget:
        return largest
    return max(smallest, int(largest * budget / weight))


BULLET_SCALE = ((2, 24, 620), (4, 20, 460), (6, 17, 340), (99, 15, 240))


def bullet_style(items, theme, font):
    """
    Bullets sized to how many there are.

    A fixed size leaves three bullets stranded in the top third of the slide and
    crushes nine. The size and the air between them move together, and the block
    is centred in its band, so a short list fills the slide instead of floating.
    """
    count = max(len(items), 1)
    size, space_below = next(
        (size, space) for limit, size, space in BULLET_SCALE if count <= limit
    )
    return {
        'size': size, 'color': theme['body'], 'font': font,
        'lineSpacing': 135, 'spaceBelow': space_below, 'vAlign': 'CENTER',
    }


def styled_text_shape(document, slide, text, box, style):
    """One positioned text box. `box` is (x, y, width, height) in 1/100 mm."""
    shape = document.createInstance('com.sun.star.drawing.TextShape')
    position = uno.createUnoStruct('com.sun.star.awt.Point')
    position.X, position.Y = int(box[0]), int(box[1])
    dimensions = uno.createUnoStruct('com.sun.star.awt.Size')
    dimensions.Width, dimensions.Height = int(box[2]), int(box[3])
    shape.Position = position
    shape.Size = dimensions
    slide.add(shape)
    shape.TextAutoGrowHeight = False
    shape.TextAutoGrowWidth = False
    shape.TextWordWrap = True
    if style.get('vAlign'):
        # Where the text sits in a fixed band. Top-anchored content is what
        # leaves the bottom half of a slide empty.
        shape.TextVerticalAdjust = uno.Enum(
            'com.sun.star.drawing.TextVerticalAdjust', style['vAlign']
        )
    shape.String = text
    cursor = shape.createTextCursor()
    cursor.gotoStart(False)
    cursor.gotoEnd(True)
    cursor.CharHeight = float(style.get('size', 18))
    cursor.CharColor = int(style.get('color', 0x000000))
    if style.get('bold'):
        cursor.CharWeight = 150.0
    if style.get('font'):
        cursor.CharFontName = style['font']
    cursor.ParaAdjust = uno.Enum(
        'com.sun.star.style.ParagraphAdjust', style.get('align', 'LEFT')
    )
    if style.get('lineSpacing'):
        spacing = uno.createUnoStruct('com.sun.star.style.LineSpacing')
        spacing.Mode = uno.getConstantByName('com.sun.star.style.LineSpacingMode.PROP')
        spacing.Height = int(style['lineSpacing'])
        cursor.ParaLineSpacing = spacing
    if style.get('spaceBelow'):
        # Air between bullets is most of what separates a designed slide from
        # a wall of text; line spacing alone cannot give it.
        cursor.ParaBottomMargin = int(style['spaceBelow'])
    if style.get('letterSpacing'):
        cursor.CharKerning = int(style['letterSpacing'])
    # Formatting the text makes the engine re-lay-out the shape, and with a
    # vertical adjustment set it re-anchors rather than staying put. Pinning the
    # geometry afterwards is what keeps the box where the layout asked for it.
    shape.Position = position
    shape.Size = dimensions
    return shape


def translucent_accent(document, slide, box, color, transparency=88, send_back=True):
    """A soft shape behind the type, so a cover is not a flat colour field."""
    shape = document.createInstance('com.sun.star.drawing.EllipseShape')
    position = uno.createUnoStruct('com.sun.star.awt.Point')
    position.X, position.Y = int(box[0]), int(box[1])
    dimensions = uno.createUnoStruct('com.sun.star.awt.Size')
    dimensions.Width, dimensions.Height = int(box[2]), int(box[3])
    shape.Position = position
    shape.Size = dimensions
    slide.add(shape)
    shape.FillStyle = uno.Enum('com.sun.star.drawing.FillStyle', 'SOLID')
    shape.FillColor = int(color)
    shape.FillTransparence = int(transparency)
    shape.LineStyle = uno.Enum('com.sun.star.drawing.LineStyle', 'NONE')
    if send_back:
        try:
            shape.MoveToBottom()
        except Exception:
            pass
    return shape


def slide_footer(document, slide, theme, font, geometry, number, label):
    """A hairline rule and a slide number: cheap, and always missing when absent."""
    width, height = geometry
    margin = int(width * 0.08)
    accent_bar(
        document, slide,
        (margin, int(height * 0.895), width - margin * 2, int(height * 0.0016)),
        theme['muted'],
    )
    if label:
        styled_text_shape(
            document, slide, label,
            (margin, int(height * 0.912), int(width * 0.6), int(height * 0.05)),
            {'size': 9, 'color': theme['muted'], 'font': font},
        )
    styled_text_shape(
        document, slide, str(number),
        (width - margin - int(width * 0.08), int(height * 0.912),
         int(width * 0.08), int(height * 0.05)),
        {'size': 9, 'color': theme['muted'], 'font': font, 'align': 'RIGHT'},
    )


def accent_bar(document, slide, box, color, transparency=0):
    shape = document.createInstance('com.sun.star.drawing.RectangleShape')
    position = uno.createUnoStruct('com.sun.star.awt.Point')
    position.X, position.Y = int(box[0]), int(box[1])
    dimensions = uno.createUnoStruct('com.sun.star.awt.Size')
    dimensions.Width, dimensions.Height = int(box[2]), int(box[3])
    shape.Position = position
    shape.Size = dimensions
    slide.add(shape)
    shape.FillStyle = uno.Enum('com.sun.star.drawing.FillStyle', 'SOLID')
    shape.FillColor = int(color)
    if transparency:
        shape.FillTransparence = int(transparency)
    shape.LineStyle = uno.Enum('com.sun.star.drawing.LineStyle', 'NONE')
    return shape


def composed_image(document, slide, image_path, box):
    shape = document.createInstance('com.sun.star.drawing.GraphicObjectShape')
    position = uno.createUnoStruct('com.sun.star.awt.Point')
    position.X, position.Y = int(box[0]), int(box[1])
    dimensions = uno.createUnoStruct('com.sun.star.awt.Size')
    dimensions.Width, dimensions.Height = int(box[2]), int(box[3])
    shape.Position = position
    shape.Size = dimensions
    shape.GraphicURL = uno.systemPathToFileUrl(image_path)
    slide.add(shape)
    return shape


def theme_figure(document, slide, box, theme, seed):
    """
    A drawn stand-in for a photograph.

    Almost no installation has a picture provider configured, and an image slide
    with nothing to place used to fall through to one more bullet list — the
    model asked for a visual and got prose. Shapes need no asset in the package,
    no network, no key and no licence, and being built from the deck's own
    palette they look deliberate in a way a stock photograph rarely does.

    `seed` only picks between the compositions, so the same slide always draws
    the same figure and neighbouring slides do not draw the same one.
    """
    left, top, width, height = (int(value) for value in box)
    accent_bar(document, slide, (left, top, width, height), theme['gradient'])
    variant = int(seed) % 3

    if variant == 0:
        # Concentric rings, densest at the centre.
        for step, transparency in enumerate((88, 80, 70)):
            size = int(height * (0.92 - step * 0.26))
            translucent_accent(
                document, slide,
                (left + int(width * 0.58) - size // 2, top + height // 2 - size // 2,
                 size, size),
                theme['accent'], transparency=transparency, send_back=False,
            )
    elif variant == 1:
        # Bars rising to the right: the shape of a number going up, without
        # claiming to be any particular number.
        count = 5
        gap = int(width * 0.04)
        bar_width = int((width * 0.7 - gap * (count - 1)) / count)
        for step in range(count):
            bar_height = int(height * (0.16 + step * 0.13))
            accent_bar(
                document, slide,
                (left + int(width * 0.16) + step * (bar_width + gap),
                 top + height - int(height * 0.16) - bar_height, bar_width, bar_height),
                theme['accent'], transparency=max(35, 72 - step * 9),
            )
    else:
        # A field of dots with one of them picked out.
        columns, rows = 6, 4
        dot = int(min(width / columns, height / rows) * 0.34)
        step_x = int(width * 0.62 / (columns - 1))
        step_y = int(height * 0.52 / (rows - 1))
        origin_x = left + int(width * 0.19)
        origin_y = top + int(height * 0.24)
        for row in range(rows):
            for column in range(columns):
                highlighted = row == rows - 2 and column == columns - 2
                translucent_accent(
                    document, slide,
                    (origin_x + column * step_x, origin_y + row * step_y, dot, dot),
                    theme['accent'], transparency=0 if highlighted else 72,
                    send_back=False,
                )

    # A short rule at the foot, so the figure reads as a plate and not a stray
    # decoration floating on the background.
    accent_bar(
        document, slide,
        (left + int(width * 0.08), top + height - int(height * 0.07),
         int(width * 0.22), max(1, int(height * 0.012))),
        theme['accent'],
    )
    return True


CHART_CLSID = '12dcae26-281f-416f-a234-c3086127382e'

CHART_DIAGRAMS = {
    'column': 'com.sun.star.chart.BarDiagram',
    'bar': 'com.sun.star.chart.BarDiagram',
    'line': 'com.sun.star.chart.LineDiagram',
    'pie': 'com.sun.star.chart.PieDiagram',
    'area': 'com.sun.star.chart.AreaDiagram',
}


def slide_chart(document, slide, spec, theme, box):
    """
    A chart drawn on the slide from numbers the agent supplies.

    Most pictures a deck actually needs are charts, and this needs no image
    file, no download and no licence — the data is already in the request.
    """
    shape = document.createInstance('com.sun.star.drawing.OLE2Shape')
    position = uno.createUnoStruct('com.sun.star.awt.Point')
    position.X, position.Y = int(box[0]), int(box[1])
    dimensions = uno.createUnoStruct('com.sun.star.awt.Size')
    dimensions.Width, dimensions.Height = int(box[2]), int(box[3])
    shape.Position = position
    shape.Size = dimensions
    shape.CLSID = CHART_CLSID
    slide.add(shape)

    chart = shape.Model
    chart_type = spec.get('chartType', 'column')
    diagram = chart.createInstance(CHART_DIAGRAMS.get(chart_type, CHART_DIAGRAMS['column']))
    if chart_type in ('column', 'bar'):
        diagram.Vertical = chart_type == 'bar'
    chart.Diagram = diagram

    categories = [str(item) for item in (spec.get('categories') or [])]
    series = spec.get('series') or []
    data = chart.Data
    rows = []
    for index in range(len(categories)):
        row = []
        for entry in series:
            values = entry.get('values') or []
            row.append(float(values[index]) if index < len(values) else 0.0)
        rows.append(tuple(row))
    if rows:
        data.setData(tuple(rows))
        data.setRowDescriptions(tuple(categories))
        data.setColumnDescriptions(tuple(str(entry.get('name', '')) for entry in series))
        # setData writes through the live object; assigning Data back is what
        # raises "property is readonly" on this API.
        chart.attachData(data)
    chart.HasMainTitle = False
    chart.HasLegend = len(series) > 1
    theme_chart(chart, diagram, theme, len(series))
    return shape


def theme_chart(chart, diagram, theme, series_count):
    """
    Make the chart belong to the slide it sits on.

    A default LibreOffice chart is a grey wall, a white background and black
    axis labels. Dropped on a dark slide that reads as a printout taped to the
    deck — and on any slide it is the thing that makes it look unfinished.
    Every step is guarded: an older chart build missing one property should
    still produce a chart with its data.
    """
    none_fill = uno.Enum('com.sun.star.drawing.FillStyle', 'NONE')
    none_line = uno.Enum('com.sun.star.drawing.LineStyle', 'NONE')
    for target in ('Area', 'Diagram'):
        try:
            area = getattr(chart, target) if target == 'Area' else diagram
            if target == 'Area':
                area.FillStyle = none_fill
                area.LineStyle = none_line
        except Exception:
            pass
    try:
        diagram.Wall.FillStyle = none_fill
        diagram.Wall.LineStyle = none_line
    except Exception:
        pass
    # Series take the theme's own palette rather than the office default blue.
    palette = theme.get('series') or (theme['accent'],)
    for index in range(series_count):
        colour = palette[index % len(palette)]
        try:
            row = diagram.getDataRowProperties(index)
            row.FillColor = colour
            row.Color = colour
            row.LineColor = colour
            row.BorderColor = colour
        except Exception:
            pass
    # Axis and legend text in the theme's body colour — black on a dark slide
    # is simply invisible.
    for axis in ('XAxis', 'YAxis'):
        try:
            getattr(diagram, axis).CharColor = theme['body']
            getattr(diagram, axis).CharHeight = 11.0
            getattr(diagram, axis).LineColor = theme['muted']
        except Exception:
            pass
    try:
        chart.Legend.CharColor = theme['body']
        chart.Legend.CharHeight = 11.0
        chart.Legend.FillStyle = none_fill
        chart.Legend.LineStyle = none_line
    except Exception:
        pass
    # One horizontal rule per step, in a colour that stays behind the data.
    try:
        diagram.HasYAxisGrid = True
        diagram.YAxisGrid.LineColor = theme['muted']
        diagram.YAxisGrid.LineTransparence = 70
    except Exception:
        pass


def centred_band(box, fraction):
    """
    The part of a content band a fixed-height row should occupy.

    A row drawn from the top of the band strands the rest of the slide below it;
    the row is the same, it just belongs in the middle.
    """
    used = int(box[3] * fraction)
    return (box[0], box[1] + int((box[3] - used) / 2), box[2], used)


def slide_kpis(document, slide, entries, theme, font, box):
    """Two to four big numbers. The one slide everyone reads."""
    count = max(1, min(len(entries), 4))
    left_edge, top, band_width, band_height = centred_band(box, 0.62)
    gap = int(band_width * 0.03)
    tile_width = int((band_width - gap * (count - 1)) / count)
    # One size for every tile, taken from the longest number: tiles that differ
    # in size read as differing in importance, which is never what was meant.
    value_size = min(
        (fitted_size(entry.get('value', ''), 40, 22, 6) for entry in entries[:count]),
        default=40,
    )
    for index, entry in enumerate(entries[:count]):
        left = left_edge + index * (tile_width + gap)
        accent_bar(
            document, slide,
            (left, top, tile_width, int(band_height * 0.018)),
            theme['accent'],
        )
        value = str(entry.get('value', ''))
        styled_text_shape(
            document, slide, value,
            (left, top + int(band_height * 0.14), tile_width, int(band_height * 0.52)),
            {'size': value_size, 'color': theme['title'],
             'bold': True, 'font': font, 'vAlign': 'CENTER'},
        )
        styled_text_shape(
            document, slide, str(entry.get('label', '')),
            (left, top + int(band_height * 0.70), tile_width, int(band_height * 0.28)),
            {'size': 14, 'color': theme['muted'], 'font': font},
        )


def slide_steps(document, slide, entries, theme, font, box):
    """A numbered process across the slide, instead of the same bullet list."""
    count = max(1, min(len(entries), 5))
    left_edge, top, band_width, band_height = centred_band(box, 0.58)
    gap = int(band_width * 0.03)
    step_width = int((band_width - gap * (count - 1)) / count)
    marker = int(band_height * 0.26)
    for index, entry in enumerate(entries[:count]):
        left = left_edge + index * (step_width + gap)
        accent_bar(
            document, slide,
            (left, top, int(step_width * 0.18), marker),
            theme['accent'],
        )
        styled_text_shape(
            document, slide, str(index + 1),
            (left, top, int(step_width * 0.18), marker),
            {'size': 16, 'color': theme['background'], 'bold': True,
             'font': font, 'align': 'CENTER', 'vAlign': 'CENTER'},
        )
        styled_text_shape(
            document, slide, str(entry),
            (left, top + marker + int(band_height * 0.10),
             step_width, band_height - marker - int(band_height * 0.10)),
            {'size': 17, 'color': theme['body'], 'font': font, 'lineSpacing': 140},
        )


def compose_slide(document, slide, spec, theme, font, geometry):
    """Draw one slide of the deck. Every layout keeps the same margins."""
    width, height = geometry
    margin = int(width * 0.08)
    content_width = width - (margin * 2)
    layout = spec.get('layout', 'bullets')
    title = spec.get('title', '')
    body = spec.get('body') or []

    slide.Background = background_fill(document, theme['background'], theme['gradient'])

    if layout in ('title', 'closing'):
        # A cover is the slide people look at longest; it gets depth and air.
        translucent_accent(
            document, slide,
            (int(width * 0.62), int(-height * 0.18), int(width * 0.55), int(width * 0.55)),
            theme['accent'],
        )
        accent_bar(
            document, slide,
            (margin, int(height * 0.32), int(width * 0.09), int(height * 0.010)),
            theme['accent'],
        )
        # Anchored to the foot of its box, so a headline that needs a second
        # line grows up into the empty half instead of down into the subtitle.
        styled_text_shape(
            document, slide, title,
            (margin, int(height * 0.36), int(content_width * 0.86), int(height * 0.33)),
            {'size': fitted_size(title, 52, 30, 30), 'color': theme['title'],
             'bold': True, 'font': font, 'lineSpacing': 105, 'vAlign': 'BOTTOM'},
        )
        subtitle = spec.get('subtitle', '') or '\n'.join(body)
        if subtitle:
            styled_text_shape(
                document, slide, subtitle,
                (margin, int(height * 0.74), int(content_width * 0.7), int(height * 0.14)),
                {'size': 17, 'color': theme['muted'], 'font': font, 'letterSpacing': 30},
            )
        return

    if layout == 'section':
        translucent_accent(
            document, slide,
            (int(-width * 0.10), int(height * 0.30), int(width * 0.42), int(width * 0.42)),
            theme['accent'], transparency=92,
        )
        accent_bar(
            document, slide,
            (margin, int(height * 0.40), int(width * 0.05), int(height * 0.009)),
            theme['accent'],
        )
        styled_text_shape(
            document, slide, title,
            (margin, int(height * 0.44), int(content_width * 0.8), int(height * 0.24)),
            {'size': fitted_size(title, 40, 26, 34), 'color': theme['title'],
             'bold': True, 'font': font, 'lineSpacing': 105, 'vAlign': 'CENTER'},
        )
        return

    if layout == 'quote':
        styled_text_shape(
            document, slide, f'“{title}”',
            (margin, int(height * 0.26), content_width, int(height * 0.38)),
            {'size': fitted_size(title, 30, 20, 60), 'color': theme['title'],
             'font': font, 'lineSpacing': 130, 'vAlign': 'CENTER'},
        )
        if body:
            styled_text_shape(
                document, slide, f'— {body[0]}',
                (margin, int(height * 0.68), content_width, int(height * 0.10)),
                {'size': 16, 'color': theme['muted'], 'font': font},
            )
        return

    # Every remaining layout carries a heading, a rule under it, and content.
    styled_text_shape(
        document, slide, title,
        (margin, int(height * 0.075), content_width, int(height * 0.175)),
        {'size': fitted_size(title, 32, 22, 26), 'color': theme['title'],
         'bold': True, 'font': font, 'lineSpacing': 105, 'vAlign': 'BOTTOM'},
    )
    accent_bar(
        document, slide,
        (margin, int(height * 0.265), int(width * 0.06), int(height * 0.007)),
        theme['accent'],
    )
    content_top = int(height * 0.34)
    content_height = int(height * 0.52)

    if layout == 'image':
        text_width = int(content_width * 0.46)
        figure_box = (
            margin + text_width + int(width * 0.04), content_top,
            content_width - text_width - int(width * 0.04), content_height,
        )
        if spec.get('imagePath'):
            composed_image(document, slide, spec['imagePath'], figure_box)
        else:
            # No picture provider is configured on most machines. The slide the
            # model asked for still has a visual half; it is drawn, not fetched.
            theme_figure(
                document, slide, figure_box, theme,
                sum(ord(character) for character in title),
            )
        if body:
            styled_text_shape(
                document, slide, '\n'.join(f'• {item}' for item in body),
                (margin, content_top, text_width, content_height),
                bullet_style(body, theme, font),
            )
        return

    if layout == 'chart':
        slide_chart(
            document, slide, spec, theme,
            (margin, content_top, content_width, content_height),
        )
        return

    if layout == 'kpi':
        slide_kpis(
            document, slide, spec.get('kpis') or [], theme, font,
            (margin, content_top, content_width, content_height),
        )
        return

    if layout == 'steps':
        slide_steps(
            document, slide, body, theme, font,
            (margin, content_top, content_width, content_height),
        )
        return

    if layout == 'two_column':
        column_width = int((content_width - int(width * 0.04)) / 2)
        right = spec.get('right') or []
        # Both columns take the size of the longer one, or they read as two
        # different slides side by side.
        style = bullet_style(body if len(body) >= len(right) else right, theme, font)
        styled_text_shape(
            document, slide, '\n'.join(f'• {item}' for item in body),
            (margin, content_top, column_width, content_height), style,
        )
        styled_text_shape(
            document, slide, '\n'.join(f'• {item}' for item in right),
            (margin + column_width + int(width * 0.04), content_top,
             column_width, content_height), style,
        )
        return

    styled_text_shape(
        document, slide, '\n'.join(f'• {item}' for item in body),
        (margin, content_top, content_width, content_height),
        bullet_style(body, theme, font),
    )


def presentation_compose(document, request):
    pages = presentation(document)
    theme = PRESENTATION_THEMES.get(request.get('theme', 'azure'), PRESENTATION_THEMES['azure'])
    font = request.get('fontName') or ''
    slides = request.get('slides') or []
    if not slides:
        raise ValueError('slides must contain at least one slide')

    # A deck is composed, not appended to: leftover template slides are exactly
    # the "half designed" look this call exists to avoid.
    if request.get('replaceExisting', True):
        while pages.getCount() > 1:
            pages.remove(pages.getByIndex(pages.getCount() - 1))
        first = pages.getByIndex(0)
        for index in range(first.getCount() - 1, -1, -1):
            first.remove(first.getByIndex(index))

    geometry = (int(pages.getByIndex(0).Width), int(pages.getByIndex(0).Height))
    composed = 0
    for index, spec in enumerate(slides):
        slide = pages.getByIndex(0) if index == 0 else pages.insertNewByIndex(pages.getCount())
        if index > 0:
            for shape_index in range(slide.getCount() - 1, -1, -1):
                slide.remove(slide.getByIndex(shape_index))
        compose_slide(document, slide, spec, theme, font, geometry)
        # The cover and the closing carry no furniture; everything between does,
        # which is what makes the middle of a deck feel like one document.
        if spec.get('layout') not in ('title', 'closing'):
            slide_footer(
                document, slide, theme, font, geometry,
                index + 1, request.get('footer', ''),
            )
        composed += 1

    # So a slide added later can join this deck instead of landing in it.
    remember_deck_style(document, request.get('theme', 'azure'), request.get('footer', ''))
    store_copy(document, request['outputPath'])
    return {'slidesComposed': composed, 'theme': request.get('theme', 'azure')}


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
    'word_append': (False, word_append),
    'word_compose': (False, word_compose),
    'word_add_footnotes': (False, word_add_footnotes),
    'word_format_text': (False, word_format_text),
    'word_insert_table': (False, word_insert_table),
    'word_insert_image': (False, word_insert_image),
    'word_set_header_footer': (False, word_set_header_footer),
    'word_add_comment': (False, word_add_comment),
    'excel_read': (True, excel_read),
    'excel_write': (False, excel_write),
    'excel_add_comments': (False, excel_add_comments),
    'excel_sort_range': (False, excel_sort_range),
    'excel_apply_autofilter': (False, excel_apply_autofilter),
    'excel_format_range': (False, excel_format_range),
    'excel_compose_table': (False, excel_compose_table),
    'excel_add_conditional_format': (False, excel_add_conditional_format),
    'excel_create_chart': (False, excel_create_chart),
    'excel_create_pivot': (False, excel_create_pivot),
    'presentation_read': (True, presentation_read),
    'presentation_replace': (False, presentation_replace),
    'presentation_compose': (False, presentation_compose),
    'presentation_format_text': (False, presentation_format_text),
    'presentation_apply_theme': (False, presentation_apply_theme),
    'presentation_set_background': (False, presentation_set_background),
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
