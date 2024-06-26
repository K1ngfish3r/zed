// This is meant to implement the CommonMark spec https://spec.commonmark.org/.
// To understand how this parser works it is useful to at least skim the specification. I will
// sometimes refer to the Github falvored markdown spec (https://github.github.com/gfm/) instead,
// which is just an extension of the CommonMark spec. Also it is important to understand
// tree-sitters "conflicts".
//
// All code for this parser can be found in this file and in src/scanner.cc.
//
// There are 2 types of elements to parse: inline elments and block elements. Block elements
// can contain other blocks and inline elements. Inline elements can contain other inline
// elements.
//
// Each block element always spans a range of lines. A block can only end at the end of a line.
// Block structure can also always be determined by just the beginning of the line. To this
// first all open blocks get "matched" meaning that any tokens needed to keep a block open get
// parsed e.g. the ">" for block quotes. If matching fails that does not automatically mean
// that the block closes on this line. It could also be a lazy continuation. After matching new
// blocks can be opened. More documentation about the matching process can be found in the
// external scanner.
//
// Lazy continuations can happen after any newline while in a paragraph and the following line
// can be interpreted as part of the paragraph. E.g. 
//
// > foo
// bar
//
// Is just one paragraph inside a block quote. In essence this means that to check if a newline
// can be a lazy continuation we need to check if it starts with a token that can open a new block
// If yes then it cannot be a lazy continuation as in
//
// > foo
// # bar
//
// otherwise it can be. This is done by intentionally triggering a "conflict" so the parser gets
// split into two versions. Version 1 (see `$._soft_line_break`) assumes that the newline was a
// lazy continuation. It still tries to match new blocks. If it manages to we know that the newline
// was not a lazy continuation, so we trigger an error such that the parser version gets canceled.
//
// Version 2 (see `$._paragraph_end_newline`) assumes that the newline was not a lazy continuation
// and closes the paragraph. If it does not open a new block until the next newline we trigger an
// error, since the newline was actually a lazy continuation.
//
//
//
// The logic for inline structure is mostly independent of block structure. Most inline elements
// are easier to parse and do not require the external scanner or conflicts. The exception are
// inline elements that can contain other inline elements like emphasis and links. For this we
// first match the opening delimiter. We then need to split the parser state into 2 versions as
// we do not know yet if there is a closing delimiter, and if not we need to treat this opening
// delimiter as normal text. This is a very straightforward usage of tree-sitter conflicts, it
// just requires some fine tuning in dynamic precedences (see the `PRECEDENCE_LEVEL_...` constants
// below).
//
// Delimiters for emphasis need the external parser, since wether a `*` can open or close emphasis
// depends on the characters around the star. Normal tree-sitter rules can not provide this kind of
// lookahead.

// A file with all html entities, should be kept up to date with
// https://html.spec.whatwg.org/multipage/entities.json
const html_entities = require("./html_entities.json");

// Punctuation characters as specified in
// https://github.github.com/gfm/#ascii-punctuation-character
const PUNCTUATION_CHARACTERS = '!-/:-@\\[-`\\{-~';
const PUNCTUATION_CHARACTERS_ARRAY = ['!', '"', '#', '$', '%', '&', "'", '(', ')', '*', '+', ',', '-', '.', '/', ':', ';', '<', '=', '>', '?', '@', '[', '\\', ']', '^', '_', '`', '{', '|', '}', '~'];


// Regexes for html tags. A html tag for a html block (rule 7 in the spec) may not have a tag name
// in EXCULUSION_ARRAY.
const EXCULUSION_ARRAY = ['pre', 'script', 'style', 'address', 'article', 'aside', 'base', 'basefont', 'blockquote', 'body', 'caption', 'center', 'col', 'colgroup', 'dd', 'details', 'dialog', 'dir', 'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'frame', 'frameset', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'header', 'hr', 'html', 'iframe', 'legend', 'li', 'link', 'main', 'menu', 'menuitem', 'nav', 'noframes', 'ol', 'optgroup', 'option', 'p', 'param', 'section', 'source', 'summary', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'title', 'tr', 'track', 'ul'];
const HTML_OPEN_TAG_EXCLUDE = '<' + negative_regex(EXCULUSION_ARRAY, '0-9\\-', true) + '([ \\t]+[a-zA-Z_:][a-zA-Z0-9_\\.:\\-]*[ \\t]*=[ \\t]*([^ \\t\\r\\n"\'=<>`]+|\'[^\'\\r\\n]*\'|"[^"\\r\\n]*"))*[ \\t]*/?>';
const HTML_CLOSING_TAG_EXCLUDE = '</' + negative_regex(EXCULUSION_ARRAY, '0-9\\-', true) + '[ \\t]*>';

// Precedence levels for different types of inline elements. Ideally n * PRECEDENCE_LEVEL_LINK should
// for example alwys be larger than PRECEDENCE_LEVEL_EMPHASIS. The exact value is not very important.
const PRECEDENCE_LEVEL_EMPHASIS = 1;
const PRECEDENCE_LEVEL_LINK = 10;
const PRECEDENCE_LEVEL_HTML = 100;
const PRECEDENCE_LEVEL_CODE_SPAN = 100;

// !!!
// Notice the call to `add_inline_rules` which generates some additional rules related to parsing
// inline contents in different contexts.
// !!!
module.exports = grammar(add_inline_rules({
    name: 'markdown',

    // TODO: Sort these tokens in some more sensible manner
    externals: $ => [
        // This gets emmited to kill invalid parse branches. Concretely this is used to decide the ending
        // of a paragraph and together with `$._trigger_error` in `$.link_title`.
        $._error,
        // This token is used for handling of newlines in paragraphs to manually trigger a conflict.
        $._split_token,
        // This token does not actually contain the newline, but it will always get emitted by the external
        // scanner if it is valid. Usualy this is the case in `$._newline` after parsing the actual newline
        // characters.
        $._line_ending,
        // This token is used for handling paragraph newlines to signify that this is the parse branch in
        // which we try to continue the paragraph.
        $._soft_line_break_marker,
        // Most blocks that are not paragraphs and can have multiple lines will start with an opening token
        // like `$._block_quote_start` and close with `$._block_close`
        $._block_close,
        // Token encountered if we match an open block. For example a '>' at the beginning of a line
        // if we are in an (already open) block quote.
        $._block_continuation,
        $._block_quote_continuation,
        // Start token for a block quote (https://github.github.com/gfm/#block-quotes)
        $._block_quote_start,
        // Start token for an indented chunk which is part of an indented code block
        // (https://github.github.com/gfm/#indented-chunk)
        $._indented_chunk_start,
        // Markers for the different levels of an ATX heading (https://github.github.com/gfm/#atx-headings)
        // This block does not need a `$._block_close`.
        $.atx_h1_marker,
        $.atx_h2_marker,
        $.atx_h3_marker,
        $.atx_h4_marker,
        $.atx_h5_marker,
        $.atx_h6_marker,
        // Underlines for the 2 different levels of setext headings (https://github.github.com/gfm/#setext-headings)
        // This block does not need a `$._block_close`.
        $.setext_h1_underline,
        $.setext_h2_underline,
        // Just a thematic break (https://github.github.com/gfm/#thematic-breaks)
        // This block does not need a `$._block_close`.
        $._thematic_break,
        // The different possiblities for a list marker (https://github.github.com/gfm/#list-marker).
        // Marks the beginning of a list item (https://github.github.com/gfm/#list-items).
        // We need to differentiate between the different markers as lists can only
        // contain list items with the same marker.
        $._list_marker_minus,
        $._list_marker_plus,
        $._list_marker_star,
        $._list_marker_parenthesis,
        $._list_marker_dot,
        $._list_marker_minus_dont_interrupt,
        $._list_marker_plus_dont_interrupt,
        $._list_marker_star_dont_interrupt,
        $._list_marker_parenthesis_dont_interrupt,
        $._list_marker_dot_dont_interrupt,
        // Marks the beginning of a fenced code block (https://github.github.com/gfm/#fenced-code-blocks)
        // We need to differentiate between backtick and tilde code blocks since they have different closing
        // tokens.
        $._fenced_code_block_start_backtick,
        $._fenced_code_block_start_tilde,
        // Closing backticks or tildas for a fenced code block. They are used to trigger a `$._close_block`
        // which in turn will trigger a `$._block_close` at the beginning the following line.
        $._fenced_code_block_end_backtick,
        $._fenced_code_block_end_tilde,
        // Bad name. Just a whole blank line without the newline. TODO: rename this
        $._blank_line_start,

        // TOKENS FOR INLINE PARSING
        // Opening and closing delimiters
        // A openging token does not mean the text after has to be a
        // code span if there is no closing token
        $._code_span_start,
        $._code_span_close,

        // For emphasis we need to tell the parse if the last character was a whitespace (or the
        // beginning of a line) or a punctuation. These tokens never actually get emitted.
        $._last_token_whitespace,
        $._last_token_punctuation,

        // The external parser can then decide if any '*' or '_' can open / close emphasis.
        // Open should always be valid, but the external scanner will emit a close if it
        // can to be in line with the spec.
        $._emphasis_open_star,
        $._emphasis_open_underscore,
        $._emphasis_close_star,
        $._emphasis_close_underscore,

        // This is used in the case that a start token for a block is not parsed by the external
        // parser to properly update the currently open blocks in the external parser.
        $._open_block,
        // This is the same as `$._open_block`, but for blocks that cannot interrupt paragraphs
        $._open_block_dont_interrupt_paragraph,
        // Similarly this is used if the closing of a block is not decided by the external parser.
        // A `$._block_close` will be emitted at the beginning of the next line. Notice that a
        // `$._block_close` can also get emitted if the parent block closes.
        $._close_block,
        // This is a workaround so the external parser does not try to open indented blocks when
        // parsing a link reference definition.
        $._no_indented_chunk,
        // If this token is valid the external scanner will cause a error to occur to kill the current
        // parse branch.
        $._trigger_error,
    ],
    precedences: $ => [
        [$.fenced_code_block, $._text],
        [$._inline_element, $.paragraph],
        [$.setext_heading, $._block],
        [$.indented_code_block, $._block],
        [$._strong_emphasis_star, $._inline_element_no_star],
        [$._strong_emphasis_star_no_newline, $._inline_element_no_newline_no_star],
        [$._strong_emphasis_underscore, $._inline_element_no_underscore],
        [$._strong_emphasis_underscore_no_newline, $._inline_element_no_newline_no_underscore],
        [$._strong_emphasis_star_no_link, $._inline_element_no_star_no_link],
        [$._strong_emphasis_star_no_newline_no_link, $._inline_element_no_newline_no_star_no_link],
        [$._strong_emphasis_underscore_no_link, $._inline_element_no_underscore_no_link],
        [$._strong_emphasis_underscore_no_newline_no_link, $._inline_element_no_newline_no_underscore_no_link],
    ],
    // More conflicts are defined in `add_inline_rules`
    conflicts: $ => [
        [$.link_label, $._closing_tag, $._text_inline_no_link],
        [$.link_label, $._open_tag, $._text_inline_no_link],
        [$.link_label, $.hard_line_break, $._text_inline_no_link],
        [$.link_label, $._inline_element_no_link],
        [$._image_description, $._image_description_non_empty, $._text_inline],
        [$._image_description, $._image_description_non_empty, $._text_inline_no_star],
        [$._image_description, $._image_description_non_empty, $._text_inline_no_underscore],
        [$._image_shortcut_link, $._image_description],
        [$._image_inline_link, $._image_shortcut_link],
        [$._image_full_reference_link, $._image_collapsed_reference_link, $._image_shortcut_link],
        [$.shortcut_link, $._link_text],
        [$.link_destination, $.link_title],
        [$._link_destination_parenthesis, $.link_title],
        [$._soft_line_break, $._paragraph_end_newline],
        [$.link_reference_definition],
        [$.hard_line_break, $._whitespace],
        [$._link_text_non_empty, $.link_label],
    ],
    extras: $ => [],

    rules: {
        document: $ => seq(optional($._ignore_matching_tokens), repeat($._block)),

        // BLOCK STRUCTURE

        // All blocks. It is important that every block ends with a newline.
        _block: $ => choice(
            $.paragraph,
            $.setext_heading,
            $.indented_code_block,
            $.atx_heading,
            $.block_quote,
            $.thematic_break,
            $.list,
            $.fenced_code_block,
            $._blank_line,
            $.html_block,
            $.link_reference_definition,
        ),
        // just the blocks that are able to interrupt a paragraph
        _block_interrupt_paragraph: $ => choice(
            $.atx_heading,
            $.block_quote,
            $.thematic_break,
            choice( // some list items do not interrupt paragraphs
                $._list_marker_plus,
                $._list_marker_minus,
                $._list_marker_star,
                $._list_marker_dot,
                $._list_marker_parenthesis,
            ),
            $.fenced_code_block,
            $._blank_line,
            choice( // _html_block_7 cannot interrupt a paragraph
                $._html_block_1,
                $._html_block_2,
                $._html_block_3,
                $._html_block_4,
                $._html_block_5,
                $._html_block_6,
            ),
            $.setext_h1_underline,
            $.setext_h2_underline,
        ),

        // A blank line including the following newline
        _blank_line: $ => seq($._blank_line_start, $._newline),

        // A paragraph. The parsing tactic for deciding when a paragraph ends is as follows:
        // on every newline inside a paragraph a conflict is triggered manually using
        // `$._split_token` to split the parse state into two branches.
        //
        // One of them - the one that also contains a `$._soft_line_break_marker` will try to
        // continue the paragraph, but we make sure that the beginning of a new block that can
        // interrupt a paragraph can also be parsed. If this is the case we know that the paragraph
        // should have been closed and the external parser will emit an `$._error` to kill the parse
        // branch.
        //
        // The other parse branch consideres the paragraph to be over. It will be killed if no valid new
        // block is detected before the next newline. (For example it will also be killed if a indented
        // code block is detected, which cannot interrupt paragraphs).
        //
        // Either way, after the next newline only one branch will exist, so the ammount of branches
        // related to paragraphs ending does not grow.
        paragraph: $ => seq($._inline, $._paragraph_end_newline),
        indented_code_block: $ => prec.right(seq($._indented_chunk, repeat(choice($._indented_chunk, $._blank_line)))),
        _indented_chunk: $ => seq($._indented_chunk_start, repeat(choice($._text, $._newline)), $._block_close, optional($._ignore_matching_tokens)),
        block_quote: $ => seq(alias($._block_quote_start, $.block_quote_marker), optional($._ignore_matching_tokens), repeat($._block), $._block_close, optional($._ignore_matching_tokens)),
        atx_heading: $ => prec(1, seq(
            choice($.atx_h1_marker, $.atx_h2_marker, $.atx_h3_marker, $.atx_h4_marker, $.atx_h5_marker, $.atx_h6_marker),
            optional(alias($._inline_no_newline, $.heading_content)),
            $._newline
        )),
        setext_heading: $ => seq(
            alias($.paragraph, $.heading_content),
            choice($.setext_h1_underline, $.setext_h2_underline),
            $._newline
        ),
        thematic_break: $ => seq($._thematic_break, $._newline),

        list: $ => prec.right(choice($._list_plus, $._list_minus, $._list_star, $._list_dot, $._list_parenthesis)),

        _list_plus: $ => prec.right(repeat1(alias($._list_item_plus, $.list_item))),
        _list_minus: $ => prec.right(repeat1(alias($._list_item_minus, $.list_item))),
        _list_star: $ => prec.right(repeat1(alias($._list_item_star, $.list_item))),
        _list_dot: $ => prec.right(repeat1(alias($._list_item_dot, $.list_item))),
        _list_parenthesis: $ => prec.right(repeat1(alias($._list_item_parenthesis, $.list_item))),

        list_marker_plus: $ => choice($._list_marker_plus, $._list_marker_plus_dont_interrupt),
        list_marker_minus: $ => choice($._list_marker_minus, $._list_marker_minus_dont_interrupt),
        list_marker_star: $ => choice($._list_marker_star, $._list_marker_star_dont_interrupt),
        list_marker_dot: $ => choice($._list_marker_dot, $._list_marker_dot_dont_interrupt),
        list_marker_parenthesis: $ => choice($._list_marker_parenthesis, $._list_marker_parenthesis_dont_interrupt),

        _list_item_plus: $ => seq($.list_marker_plus, optional($._ignore_matching_tokens), $._list_item_content, $._block_close, optional($._ignore_matching_tokens)),
        _list_item_minus: $ => seq($.list_marker_minus, optional($._ignore_matching_tokens), $._list_item_content, $._block_close, optional($._ignore_matching_tokens)),
        _list_item_star: $ => seq($.list_marker_star, optional($._ignore_matching_tokens), $._list_item_content, $._block_close, optional($._ignore_matching_tokens)),
        _list_item_dot: $ => seq($.list_marker_dot, optional($._ignore_matching_tokens), $._list_item_content, $._block_close, optional($._ignore_matching_tokens)),
        _list_item_parenthesis: $ => seq($.list_marker_parenthesis, optional($._ignore_matching_tokens), $._list_item_content, $._block_close, optional($._ignore_matching_tokens)),

        _list_item_content: $ => choice(
            prec(1, seq($._blank_line, $._blank_line, $._close_block, optional($._ignore_matching_tokens))),
            repeat1($._block),
        ),

        fenced_code_block: $ => prec.right(choice(
            seq(
                alias($._fenced_code_block_start_backtick, $.fenced_code_block_delimiter),
                optional($._whitespace),
                optional($.info_string),
                $._newline,
                optional($.code_fence_content),
                optional(seq(alias($._fenced_code_block_end_backtick, $.fenced_code_block_delimiter), $._close_block, $._newline)),
                $._block_close,
            ),
            seq(
                alias($._fenced_code_block_start_tilde, $.fenced_code_block_delimiter),
                optional($._whitespace),
                optional($.info_string),
                $._newline,
                optional($.code_fence_content),
                optional(seq(alias($._fenced_code_block_end_tilde, $.fenced_code_block_delimiter), $._close_block, $._newline)),
                $._block_close,
            ),
        )),
        code_fence_content: $ => repeat1(choice($._newline, $._text)),
        info_string: $ => choice(
            seq($.language, repeat(choice($._text, $.backslash_escape, $.entity_reference, $.numeric_character_reference))),
            repeat1(choice($._text, $.backslash_escape, $.entity_reference, $.numeric_character_reference)),
        ),
        language: $ => prec.right(repeat1(prec(1, choice($._word, punctuation_without($, []), $.backslash_escape, $.entity_reference, $.numeric_character_reference)))), 

        _html_block_1: $ => build_html_block($, new RegExp('<' + regex_case_insensitive_list(['script', 'style', 'pre']) + '([\\r\\n]|[ \\t>][^<\\r\\n]*(\\n|\\r\\n?)?)'), new RegExp('</' + regex_case_insensitive_list(['script', 'style', 'pre']) + '>'), true),
        _html_block_2: $ => build_html_block($, '<!--', '-->', true),
        _html_block_3: $ => build_html_block($, '<?', '?>', true),
        _html_block_4: $ => build_html_block($, /<![A-Z]+/, '>', true),
        _html_block_5: $ => build_html_block($, '<![CDATA[', ']]>', true),
        _html_block_6: $ => choice(
            build_html_block(
                $,
                new RegExp('</?' + regex_case_insensitive_list(['address', 'article', 'aside', 'base', 'basefont', 'blockquote', 'body', 'caption', 'center', 'col', 'colgroup', 'dd', 'details', 'dialog', 'dir', 'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'frame', 'frameset', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'header', 'hr', 'html', 'iframe', 'legend', 'li', 'link', 'main', 'menu', 'menuitem', 'nav', 'noframes', 'ol', 'optgroup', 'option', 'p', 'param', 'section', 'source', 'summary', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'title', 'tr', 'track', 'ul']) + '([ \\t>]|/>)'),
                seq($._newline, $._blank_line),
                true
            ),
            build_html_block_after_newline(
                $,
                new RegExp('</?' + regex_case_insensitive_list(['address', 'article', 'aside', 'base', 'basefont', 'blockquote', 'body', 'caption', 'center', 'col', 'colgroup', 'dd', 'details', 'dialog', 'dir', 'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'frame', 'frameset', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'header', 'hr', 'html', 'iframe', 'legend', 'li', 'link', 'main', 'menu', 'menuitem', 'nav', 'noframes', 'ol', 'optgroup', 'option', 'p', 'param', 'section', 'source', 'summary', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'title', 'tr', 'track', 'ul']) + '(\\n|\\r\\n?)'),
                true
            ),
        ),
        _html_block_7: $ => choice(
            build_html_block(
                $,
                choice($._open_tag_html_block, $._closing_tag_html_block),
                seq($._newline, $._blank_line),
                false
            ),
            build_html_block_after_newline(
                $,
                choice($._open_tag_html_block_newline, $._closing_tag_html_block_newline),
                false
            ),
        ),
        html_block: $ => prec(1, seq(optional($._whitespace), choice(
            $._html_block_1,
            $._html_block_2,
            $._html_block_3,
            $._html_block_4,
            $._html_block_5,
            $._html_block_6,
            $._html_block_7,
        ))),
        _open_tag_html_block: $ => new RegExp(HTML_OPEN_TAG_EXCLUDE + '[ \\t]'),
        _open_tag_html_block_newline: $ => new RegExp(HTML_OPEN_TAG_EXCLUDE + '(\n|\r\n?)'),
        _closing_tag_html_block: $ => new RegExp(HTML_CLOSING_TAG_EXCLUDE + '[ \\t]'),
        _closing_tag_html_block_newline: $ => new RegExp(HTML_CLOSING_TAG_EXCLUDE + '(\n|\r\n?)'),

        link_reference_definition: $ => prec.dynamic(PRECEDENCE_LEVEL_LINK, seq(
            optional($._whitespace),
            $.link_label,
            ':',
            optional(seq(optional($._whitespace), optional(seq($._soft_line_break, optional($._whitespace))))),
            $.link_destination,
            optional(prec.dynamic(2 * PRECEDENCE_LEVEL_LINK, seq(
                choice(
                    seq($._whitespace, optional(seq($._newline, optional($._whitespace)))),
                    seq($._newline, optional($._whitespace)),
                ),
                optional($._no_indented_chunk),
                $.link_title
            ))),
            $._newline,
        )),

        shortcut_link: $ => prec.dynamic(PRECEDENCE_LEVEL_LINK, $._link_text_non_empty), // TODO: no newline
        full_reference_link: $ => prec.dynamic(PRECEDENCE_LEVEL_LINK, seq(
            $._link_text,
            $.link_label
        )), // TODO: no newline
        collapsed_reference_link: $ => prec.dynamic(PRECEDENCE_LEVEL_LINK, seq(
            $._link_text,
            '[',
            ']'
        )), // TODO: no newline
        inline_link: $ => prec.dynamic(PRECEDENCE_LEVEL_LINK, seq(
            $._link_text,
            '(',
            repeat(choice($._whitespace, $._soft_line_break)),
            optional(seq(
                choice(
                    seq($.link_destination, optional(seq(repeat1(choice($._whitespace, $._soft_line_break)), $.link_title))),
                    $.link_title,
                ),
                repeat(choice($._whitespace, $._soft_line_break)),
            )),
            ')'
        )), // TODO: no newline
        image: $ => choice($._image_inline_link, $._image_shortcut_link, $._image_full_reference_link, $._image_collapsed_reference_link), // TODO no newline
        _image_inline_link: $ => prec.dynamic(PRECEDENCE_LEVEL_LINK, seq(
            $._image_description,
            '(',
            repeat(choice($._whitespace, $._soft_line_break)),
            optional(seq(
                choice(
                    seq($.link_destination, optional(seq(repeat1(choice($._whitespace, $._soft_line_break)), $.link_title))),
                    $.link_title,
                ),
                repeat(choice($._whitespace, $._soft_line_break)),
            )),
            ')'
        )),
        _image_shortcut_link: $ => prec.dynamic(3 * PRECEDENCE_LEVEL_LINK, $._image_description_non_empty),
        _image_full_reference_link: $ => prec.dynamic(PRECEDENCE_LEVEL_LINK, seq($._image_description, $.link_label)),
        _image_collapsed_reference_link: $ => prec.dynamic(PRECEDENCE_LEVEL_LINK, seq($._image_description, '[', ']')),

        _link_text: $ => prec.dynamic(PRECEDENCE_LEVEL_LINK, choice($._link_text_non_empty, seq('[', ']'))),
        _link_text_non_empty: $ => seq('[', alias($._inline_no_link, $.link_text), ']'),
        _image_description: $ => prec.dynamic(3 * PRECEDENCE_LEVEL_LINK, choice($._image_description_non_empty, seq('!', '[', prec(1, ']')))),
        _image_description_non_empty: $ => seq('!', '[', alias($._inline, $.image_description), prec(1, ']')),
        link_label: $ => seq('[', repeat1(choice($._text_inline_no_link, $.backslash_escape, $._newline)), ']'),
        link_destination: $ => prec.dynamic(PRECEDENCE_LEVEL_LINK, choice(
            seq('<', repeat(choice($._text_no_angle, $.backslash_escape)), '>'),
            seq(
                choice($._word, punctuation_without($, ['<', '(', ')']), $.backslash_escape, $.entity_reference, $.numeric_character_reference, $._link_destination_parenthesis),
                repeat(choice($._word, punctuation_without($, ['(', ')']), $.backslash_escape, $.entity_reference, $.numeric_character_reference, $._link_destination_parenthesis)),
            )
        )),
        _link_destination_parenthesis: $ => seq('(', repeat(choice($._word, $.backslash_escape, $._link_destination_parenthesis)), ')'),
        link_title: $ => choice(
            seq('"', repeat(choice(
                $._word,
                punctuation_without($, ['"']),
                $._whitespace,
                $.backslash_escape,
                $.entity_reference,
                $.numeric_character_reference,
                seq($._newline, optional(seq($._blank_line, $._trigger_error)))
            )), '"'),
            seq("'", repeat(choice(
                $._word,
                punctuation_without($, ["'"]),
                $._whitespace,
                $.backslash_escape,
                $.entity_reference,
                $.numeric_character_reference,
                seq($._newline, optional(seq($._blank_line, $._trigger_error)))
            )), "'"),
            seq('(', repeat(choice(
                $._word,
                punctuation_without($, ['(', ')']),
                $._whitespace,
                $.backslash_escape,
                $.entity_reference,
                $.numeric_character_reference,
                seq($._newline, optional(seq($._blank_line, $._trigger_error)))
            )), ')'),
        ),
        _text_no_angle: $ => choice($._word, punctuation_without($, ['<', '>']), $._whitespace),

        _soft_line_break: $ => prec.right(seq(
            $._newline,
            repeat(choice($._split_token, $._soft_line_break_marker)),
            $._soft_line_break_marker,
            optional($._block_interrupt_paragraph), // not actually valid, we will error if it manages to match a block
        )),
        _paragraph_end_newline: $ => seq($._newline, repeat($._split_token)),

        backslash_escape: $ => new RegExp('\\\\[' + PUNCTUATION_CHARACTERS + ']'),
        hard_line_break: $ => prec.dynamic(1, seq(choice('\\', $._whitespace_ge_2), $._soft_line_break)),
        uri_autolink: $ => /<[a-zA-Z][a-zA-Z0-9+\.\-][a-zA-Z0-9+\.\-]*:[^ \t\r\n<>]*>/, // TODO: move this to external scanner because lexer is really inefficient with counting characters for scheme (so we can ensure protocol is no longer than 32 chars)
        email_autolink: $ => /<[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*>/,
        _text: $ => choice($._word, punctuation_without($, []), $._whitespace),
        entity_reference: $ => html_entity_regex(),
        numeric_character_reference: $ => /&#([0-9]{1,7}|[xX][0-9a-fA-F]{1,6});/,

        html_tag: $ => choice($._open_tag, $._closing_tag, $._html_comment, $._processing_instruction, $._declaration, $._cdata_section),
        _open_tag: $ => prec.dynamic(PRECEDENCE_LEVEL_HTML, seq('<', $._tag_name, repeat($._attribute), repeat(choice($._whitespace, $._soft_line_break)), optional('/'), '>')),
        _closing_tag: $ => prec.dynamic(PRECEDENCE_LEVEL_HTML, seq('<', '/', $._tag_name, repeat(choice($._whitespace, $._soft_line_break)), '>')),
        _tag_name: $ => seq($._word_no_digit, repeat(choice($._word_no_digit, $._digits, '-'))),
        _attribute: $ => seq(repeat1(choice($._whitespace, $._soft_line_break)), $._attribute_name, repeat(choice($._whitespace, $._soft_line_break)), '=', repeat(choice($._whitespace, $._soft_line_break)), $._attribute_value),
        _attribute_name: $ => /[a-zA-Z_:][a-zA-Z0-9_\.:\-]*/,
        _attribute_value: $ => choice(
            /[^ \t\r\n"'=<>`]+/,
            seq("'", repeat(choice($._word, $._whitespace, $._soft_line_break, punctuation_without($, ["'"]))), "'"),
            seq('"', repeat(choice($._word, $._whitespace, $._soft_line_break, punctuation_without($, ['"']))), '"'),
        ),
        _html_comment: $ => prec.dynamic(PRECEDENCE_LEVEL_HTML, seq(
            '<!--',
            optional(choice(
                $._word,
                $._whitespace,
                $._newline,
                punctuation_without($, ['-', '>']),
                seq(
                    '-',
                    punctuation_without($, ['>']),
                )
            )),
            repeat(prec.right(choice(
                $._word,
                $._whitespace,
                $._newline,
                punctuation_without($, []),
            ))),
            '-->'
        )),
        _processing_instruction: $ => prec.dynamic(PRECEDENCE_LEVEL_HTML, seq(
            '<?',
            repeat(prec.right(choice(
                $._word,
                $._whitespace,
                $._newline,
                punctuation_without($, []),
            ))),
            '?>'
        )),
        _declaration: $ => prec.dynamic(PRECEDENCE_LEVEL_HTML, seq(
            /<![A-Z]+/,
            choice(
                $._whitespace,
                $._newline,
            ),
            repeat(prec.right(choice(
                $._word,
                $._whitespace,
                $._newline,
                punctuation_without($, ['>']),
            ))),
            '>'
        )),
        _cdata_section: $ => prec.dynamic(PRECEDENCE_LEVEL_HTML, seq(
            '<![CDATA[',
            repeat(prec.right(choice(
                $._word,
                $._whitespace,
                $._newline,
                punctuation_without($, []),
            ))),
            ']]>'
        )),

        _whitespace_ge_2: $ => /\t| [ \t]+/,
        _whitespace: $ => seq(choice($._whitespace_ge_2, / /), optional($._last_token_whitespace)),
        _word: $ => choice($._word_no_digit, $._digits),
        _word_no_digit: $ => new RegExp('[^' + PUNCTUATION_CHARACTERS + ' \\t\\n\\r0-9]+'),
        _digits: $ => /[0-9]+/,
        _newline: $ => prec.right(seq(
            /\n|\r\n?/,
            optional($._line_ending),
            optional($._ignore_matching_tokens)
        )),
        _ignore_matching_tokens: $ => repeat1(choice($._block_continuation, alias($._block_quote_continuation, $.block_quote_marker), $._last_token_whitespace)),
    },
}));

function add_inline_rules(grammar) {
    let conflicts = [];
    for (let newline of [true, false]) {
        let suffix_newline = newline ? "" : "_no_newline";
        for (let link of [true, false]) {
            let suffix_link = link ? "" : "_no_link";
            for (let delimiter of [false, "star", "underscore"]) {
                let suffix_delimiter = delimiter ? "_no_" + delimiter : "";
                let suffix = suffix_newline + suffix_delimiter + suffix_link;
                grammar.rules["_inline_element" + suffix] = $ => {
                    let elements = [
                        $.backslash_escape,
                        $.hard_line_break,
                        $.uri_autolink,
                        $.email_autolink,
                        $['_text_inline' + suffix_delimiter + suffix_link],
                        $.entity_reference,
                        $.numeric_character_reference,
                        alias($['_code_span' + suffix_newline], $.code_span),
                        $.html_tag,
                        alias($['_emphasis_star' + suffix_newline + suffix_link], $.emphasis),
                        alias($['_strong_emphasis_star' + suffix_newline + suffix_link], $.strong_emphasis),
                        alias($['_emphasis_underscore' + suffix_newline + suffix_link], $.emphasis),
                        alias($['_strong_emphasis_underscore' + suffix_newline + suffix_link], $.strong_emphasis),
                        $.image,
                    ];
                    if (newline) {
                        elements = elements.concat([
                            $._soft_line_break,
                        ]);
                    }
                    if (link) {
                        elements = elements.concat([
                            $.shortcut_link,
                            $.full_reference_link,
                            $.collapsed_reference_link,
                            $.inline_link,
                        ]);
                    }
                    return choice(...elements);
                };
                grammar.rules["_inline" + suffix] = $ => repeat1($["_inline_element" + suffix]);
                conflicts.push(['_code_span' + suffix_newline, '_text_inline' + suffix_delimiter + suffix_link]);
                if (delimiter !== "star") {
                    conflicts.push(['_emphasis_star' + suffix_newline + suffix_link, '_text_inline' + suffix_delimiter + suffix_link]);
                    conflicts.push(['_emphasis_star' + suffix_newline + suffix_link, '_strong_emphasis_star' + suffix_newline + suffix_link, '_text_inline' + suffix_delimiter + suffix_link]);
                }
                if (delimiter !== false) {
                    conflicts.push(['_strong_emphasis_' + delimiter + suffix_newline + suffix_link, '_inline_element_no_' + delimiter]);
                }
                if (delimiter !== "underscore") {
                    conflicts.push(['_emphasis_underscore' + suffix_newline + suffix_link, '_text_inline' + suffix_delimiter + suffix_link]);
                    conflicts.push(['_emphasis_underscore' + suffix_newline + suffix_link, '_strong_emphasis_underscore' + suffix_newline + suffix_link, '_text_inline' + suffix_delimiter + suffix_link]);
                }

                if (newline) {
                    conflicts.push(['_html_comment', '_text_inline' + suffix_delimiter + suffix_link]); // TODO: no_newline
                    conflicts.push(['_cdata_section', '_text_inline' + suffix_delimiter + suffix_link]);
                    conflicts.push(['_declaration', '_text_inline' + suffix_delimiter + suffix_link]);
                    conflicts.push(['_processing_instruction', '_text_inline' + suffix_delimiter + suffix_link]);
                    conflicts.push(['_closing_tag', '_text_inline' + suffix_delimiter + suffix_link]);
                    conflicts.push(['_open_tag', '_text_inline' + suffix_delimiter + suffix_link]);
                    conflicts.push(['_link_text_non_empty', 'link_label', '_text_inline' + suffix_delimiter + suffix_link]);
                    conflicts.push(['_link_text_non_empty', '_text_inline' + suffix_delimiter + suffix_link]);
                    conflicts.push(['_link_text', '_text_inline' + suffix_delimiter + suffix_link]);
                    conflicts.push(['link_label', '_text_inline' + suffix_delimiter + suffix_link]);
                    conflicts.push(['link_reference_definition', '_text_inline' + suffix_delimiter + suffix_link]);
                    conflicts.push(['hard_line_break', '_text_inline' + suffix_delimiter + suffix_link]);
                    grammar.rules['_text_inline' + suffix_delimiter + suffix_link] = $ => {
                        let elements = [
                            $._word,
                            punctuation_without($, link ? [] : ['[', ']']),
                            $._whitespace,
                            $._code_span_start,
                            '<!--',
                            /<![A-Z]+/,
                            '<?',
                            '<![CDATA[',
                        ];
                        if (delimiter !== "star") {
                            elements.push($._emphasis_open_star);
                        }
                        if (delimiter !== "underscore") {
                            elements.push($._emphasis_open_underscore);
                        }
                        return choice(...elements);
                    }
                }
            }
            
            grammar.rules['_emphasis_star' + suffix_newline + suffix_link] = $ => prec.dynamic(PRECEDENCE_LEVEL_EMPHASIS, seq(alias($._emphasis_open_star, $.emphasis_delimiter), $['_inline' + suffix_newline + '_no_star' + suffix_link], alias($._emphasis_close_star, $.emphasis_delimiter)));
            grammar.rules['_strong_emphasis_star' + suffix_newline + suffix_link] = $ => prec.dynamic(2 * PRECEDENCE_LEVEL_EMPHASIS, seq(alias($._emphasis_open_star, $.emphasis_delimiter), $['_emphasis_star' + suffix_newline + suffix_link], alias($._emphasis_close_star, $.emphasis_delimiter)));
            grammar.rules['_emphasis_underscore' + suffix_newline + suffix_link] = $ => prec.dynamic(PRECEDENCE_LEVEL_EMPHASIS, seq(alias($._emphasis_open_underscore, $.emphasis_delimiter), $['_inline' + suffix_newline + '_no_underscore' + suffix_link], alias($._emphasis_close_underscore, $.emphasis_delimiter)));
            grammar.rules['_strong_emphasis_underscore' + suffix_newline + suffix_link] = $ => prec.dynamic(2 * PRECEDENCE_LEVEL_EMPHASIS, seq(alias($._emphasis_open_underscore, $.emphasis_delimiter), $['_emphasis_underscore' + suffix_newline + suffix_link], alias($._emphasis_close_underscore, $.emphasis_delimiter)));
        }
        grammar.rules['_code_span' + suffix_newline] = $ => prec.dynamic(PRECEDENCE_LEVEL_CODE_SPAN, seq(alias($._code_span_start, $.code_span_delimiter), repeat(newline ? choice($._text, $._soft_line_break) : $._text), alias($._code_span_close, $.code_span_delimiter)));
    }

    let old = grammar.conflicts
    grammar.conflicts = $ => {
        let cs = old($);
        for (let conflict of conflicts) {
            let c = [];
            for (let rule of conflict) {
                c.push($[rule]);
            }
            cs.push(c);
        }
        return cs;
    }
    
    return grammar;
}

function html_entity_regex() {
    let s = '&(';
    s += Object.keys(html_entities).map(name => name.substring(1, name.length - 1)).join('|');
    s += ');';
    return new RegExp(s);
}

function build_html_block_after_newline($, open, interrupt_paragraph) {
    return seq(
        open,
        interrupt_paragraph ? $._open_block : $._open_block_dont_interrupt_paragraph,
        $._line_ending,
        optional($._ignore_matching_tokens),
        optional(seq($._blank_line, $._close_block)),
        repeat(choice(
            $._whitespace,
            $._word,
            punctuation_without($, []),
            $._newline,
            seq($._newline, $._blank_line, $._close_block),
        )),
        $._block_close,
        optional($._ignore_matching_tokens),
    );
}

function build_html_block($, open, close, interrupt_paragraph) {
    return seq(
        open,
        interrupt_paragraph ? $._open_block : $._open_block_dont_interrupt_paragraph,
        repeat(choice(
            $._whitespace,
            $._word,
            punctuation_without($, []),
            $._newline,
            seq(close, $._close_block),
        )),
        $._block_close,
        optional($._ignore_matching_tokens),
    );
}

function regex_case_insensitive_list(ss) {
    return "(" + ss.map(x => regex_case_insensitive(x)).join("|") + ")";
}

function regex_case_insensitive(s) {
    return Array.from(s).map(x => "[" + x + x.toUpperCase() + "]").join("");
}

function punctuation_without($, chars) {
    return seq(choice(...PUNCTUATION_CHARACTERS_ARRAY.filter(c => !chars.includes(c))), optional($._last_token_punctuation));
}

// used to build a regex that matches anything but pre, script and style
function negative_regex(ss, classExtra, isStart) {
    let chars = {};
    let end = true;
    for (let s of ss) {
        if (s.length > 1) {
            end = false;
        }
        let char = s.charCodeAt(0);
        if (!(char in chars)) {
            chars[char] = [];
        }
        chars[char].push(s);
    }
    let ranges = [['a'.charCodeAt(0), 'z'.charCodeAt(0)]];
    if (!isStart) {
        ranges.splice(0, 0, ['0'.charCodeAt(0), '9'.charCodeAt(0)]);
    }
    for (let char in chars) {
        for (let i = 0; i < ranges.length; i++) {
            let range = ranges[i];
            if (range[1] < char) continue;
            if (range[1] != char && range[0] != char) {
                ranges.splice(i, 1, [range[0], char - 1], [+char + 1, range[1]]);
            } else if(range[1] == char && range[0] == char) {
                ranges.splice(i, 1);
            } else if (range[1] == char) {
                range[1]--;
            } else {
                range[0]++;
            }
            break;
        }
    }
    let alphabet = ranges.map(x => {
        if (x[0] >= 97) { // is letter
            if (x[0] == x[1]) {
                return String.fromCharCode(x[0]) + String.fromCharCode(x[0]).toUpperCase();
            } else {
                return String.fromCharCode(x[0]) + '-' + String.fromCharCode(x[1]) + String.fromCharCode(x[0]).toUpperCase() + '-' + String.fromCharCode(x[1]).toUpperCase();
            }
        } else {
            if (x[0] == x[1]) {
                return String.fromCharCode(x[0]);
            } else {
                return String.fromCharCode(x[0]) + '-' + String.fromCharCode(x[1]);
            }
        }
    }).join('');
    let output = '([' + alphabet + (isStart ? '' : classExtra) + '][a-zA-Z' + classExtra + ']*';
    if (!end) {
        for (let char in chars) {
            output += '|' + String.fromCharCode(char);
            let new_ss = chars[char].map(x => x.substring(1)).filter(x => x.length != 0)
            if (new_ss.length > 0) {
                output += '|' + String.fromCharCode(char) + negative_regex(new_ss, classExtra, false);
            } else {
                output += '[a-zA-Z' + classExtra + ']+';
            }
        }
    } else {
        output += '|[' + Object.keys(chars).map(x => String.fromCharCode(x)).join('') + '][a-zA-Z' + classExtra + ']+';
    }
    output += ')';
    return output;
}

