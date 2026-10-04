"""Every chrome colour is a theme token.

applyChromeTheme() (frontend/js/themes.js) re-aims the whole palette when the
theme changes. A literal colour in a stylesheet is the one pixel that does not
follow, and on a light theme it is usually a dark smudge on paper. So outside a
``:root`` block no stylesheet may name a colour: it reads a token from
``app.css :root`` or mixes one with ``color-mix()``. The same goes for colour
literals in the frontend scripts, where only themes.js may hold palette data.
"""

import re
from pathlib import Path

FRONTEND = Path(__file__).parents[1] / "quickterm" / "frontend"
CSS_DIR = FRONTEND / "css"
JS_DIR = FRONTEND / "js"

# (file, literal) pairs that may stay, each with its reason. Keep this short.
CSS_ALLOWED: dict[tuple[str, str], str] = {}
# themes.js is the palette: the theme data and the mixing endpoints live there.
JS_ALLOWED_FILES = {"themes.js": "the theme palettes and applyChromeTheme() itself"}

NAMED_COLOURS = set(
    """
    aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond
    blue blueviolet brown burlywood cadetblue chartreuse chocolate coral
    cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray
    darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid
    darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey
    darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue
    firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod
    gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki
    lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan
    lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon
    lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue
    lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue
    mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen
    mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin
    navajowhite navy oldlace olive olivedrab orange orangered orchid
    palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru
    pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown
    salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray
    slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet
    wheat white whitesmoke yellow yellowgreen
    """.split()
)
FUNCTION = re.compile(r"\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(", re.IGNORECASE)
HEX = re.compile(r"#[0-9a-fA-F]{3,8}\b")
DECLARATION = re.compile(r"([-a-zA-Z]+)\s*:\s*([^;{}]+)(?=[;}])")


def _strip(css: str) -> str:
    css = re.sub(r"/\*.*?\*/", "", css, flags=re.DOTALL)
    return re.sub(r"\"[^\"]*\"|'[^']*'", '""', css)


def _without_root_blocks(css: str) -> str:
    """Drop every rule whose selector is a :root selector, braces balanced."""
    out = []
    index = 0
    for match in re.finditer(r"(^|[}\s;])(:root[^{]*)\{", css):
        if match.start(2) < index:
            continue
        out.append(css[index : match.start(2)])
        depth = 0
        cursor = match.end() - 1
        while cursor < len(css):
            if css[cursor] == "{":
                depth += 1
            elif css[cursor] == "}":
                depth -= 1
                if depth == 0:
                    break
            cursor += 1
        index = cursor + 1
    out.append(css[index:])
    return "".join(out)


def css_colour_literals(css: str) -> list[tuple[str, str]]:
    """(literal, declaration) for every colour named outside :root."""
    found = []
    for prop, value in DECLARATION.findall(_without_root_blocks(_strip(css))):
        hits = HEX.findall(value) + [m.group(0) for m in FUNCTION.finditer(value)]
        hits += [word for word in re.findall(r"[a-zA-Z]+", value) if word.lower() in NAMED_COLOURS]
        found += [(hit, f"{prop}: {value.strip()}") for hit in hits]
    return found


def test_the_scanner_sees_what_it_must_and_skips_root():
    sample = """
    :root { --a: #123456; --b: rgba(0, 0, 0, .4); }
    :root[data-theme-mode="light"] { color-scheme: light; }
    #grid > .pane { border: 1px solid var(--line); white-space: nowrap; }
    .x { color: #abc; background: rgba(1, 2, 3, .5); }
    .y { outline-color: white; content: "red"; }
    /* .z { color: red; } */
    @media (forced-colors: active) { .w { border-color: CanvasText; } }
    """
    hits = css_colour_literals(sample)
    assert [literal for literal, _ in hits] == ["#abc", "rgba(", "white"], hits


def test_stylesheets_name_no_colour_outside_root():
    problems = []
    for path in sorted(CSS_DIR.glob("*.css")):
        for literal, declaration in css_colour_literals(path.read_text(encoding="utf-8")):
            if (path.name, literal) not in CSS_ALLOWED:
                problems.append(f"{path.name}: {declaration}")
    assert not problems, "colour literals outside :root:\n" + "\n".join(problems)


def test_scripts_hold_no_colour_literals_outside_themes_js():
    literal = re.compile(
        r"[\"'`](#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?|#[0-9a-fA-F]{3})[\"'`]|\brgba?\(\s*\d"
    )
    problems = []
    for path in sorted(JS_DIR.glob("*.js")):
        if path.name in JS_ALLOWED_FILES:
            continue
        for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            if literal.search(line):
                problems.append(f"{path.name}:{number}: {line.strip()}")
    assert not problems, "colour literals in scripts:\n" + "\n".join(problems)


def test_light_themes_switch_the_native_colour_scheme():
    app_css = (CSS_DIR / "app.css").read_text(encoding="utf-8")
    themes = (JS_DIR / "themes.js").read_text(encoding="utf-8")
    assert "color-scheme: dark;" in app_css
    assert ':root[data-theme-mode="light"] { color-scheme: light; }' in app_css
    assert 'document.documentElement.dataset.themeMode = light ? "light" : "dark";' in themes


def test_the_native_window_paints_the_pre_boot_background():
    # pywebview paints WINDOW_BACKGROUND before the page loads; anything other
    # than --bg flashes a second colour at every start.
    from quickterm import app

    css = (CSS_DIR / "app.css").read_text(encoding="utf-8")
    root = css[css.index(":root {"):css.index("}", css.index(":root {"))]
    match = re.search(r"--bg: (#[0-9a-fA-F]{6});", root)
    assert match, "--bg is a literal in app.css :root"
    assert app.WINDOW_BACKGROUND.lower() == match.group(1).lower()
