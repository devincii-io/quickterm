# Third-party notices

QuickTerm releases redistribute the third-party binaries below. Each is
MIT-licensed; the required notices follow.

## PuTTY (plink.exe, pscp.exe, psftp.exe)

Bundled in the `putty/` folder of the installed application; version and
SHA-256 hashes are pinned in `scripts/fetch_putty.py`. Source:
https://www.chiark.greenend.org.uk/~sgtatham/putty/

PuTTY is copyright 1997-2026 Simon Tatham.

Portions copyright Robert de Bath, Joris van Rantwijk, Delian Delchev,
Andreas Schultz, Jeroen Massar, Wez Furlong, Nicolas Barry, Justin Bradford,
Ben Harris, Malcolm Smith, Ahmad Khalifa, Markus Kuhn, Colin Watson,
Christopher Staite, Lorenz Diener, Christian Brabandt, Jeff Smith,
Pavel Kryukov, Maxim Kuznetsov, Svyatoslav Kuzmich, Nico Williams,
Viktor Dukhovni, Josh Dersch, Lars Brinkhoff, and CORE SDI S.A.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL SIMON
TATHAM BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN
ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## winpty / pywinpty (winpty.dll, winpty-agent.exe)

Bundled in the `winpty/` folder via the pywinpty package
(https://github.com/andfoy/pywinpty, MIT, copyright Spyder project
contributors). winpty itself is copyright (c) 2011-2016 Ryan Prichard and
released under the MIT License (https://github.com/rprichard/winpty).

## Windows Console / ConPTY host (OpenConsole.exe, conpty.dll)

Bundled in the `winpty/` folder via pywinpty; built from Microsoft's Windows
Terminal / Console repository (https://github.com/microsoft/terminal),
copyright (c) Microsoft Corporation, released under the MIT License.
