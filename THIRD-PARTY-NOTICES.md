# Third-party notices

QuickTerm releases redistribute the third-party binaries and colour themes
below. The required notices follow.

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

## Windows Console / ConPTY host (OpenConsole.exe, conpty.dll)

Bundled in the `conpty/` folder, taken from the pywinpty package
(https://github.com/andfoy/pywinpty, MIT, copyright Spyder project
contributors); built from Microsoft's Windows Terminal / Console repository
(https://github.com/microsoft/terminal), copyright (c) Microsoft
Corporation, released under the MIT License.

## Terminal colour themes

The built-in themes in `quickterm/frontend/js/themes.js` reproduce the colour
values of these themes, taken from each project's own terminal port and UI
palette. Each is MIT-licensed under the permission notice quoted in the PuTTY
section above, with the copyright line given here, except where noted.

- Catppuccin (https://github.com/catppuccin/ghostty,
  https://github.com/catppuccin/palette): Copyright (c) 2021 Catppuccin.
- Tokyo Night (https://github.com/folke/tokyonight.nvim): by Folke
  Lemaitre. The repository is licensed under the Apache License 2.0
  (https://www.apache.org/licenses/LICENSE-2.0); the terminal ports under
  `extras/` that the values come from are labelled MIT.
- Rosé Pine (https://github.com/rose-pine/ghostty,
  https://github.com/rose-pine/palette): Copyright (c) Rosé Pine,
  Copyright (c) mvllow.
- Kanagawa (https://github.com/rebelot/kanagawa.nvim): Copyright (c) 2021
  Tommaso Laurenzi.
- Gruvbox (https://github.com/morhetz/gruvbox,
  https://github.com/morhetz/gruvbox-contrib): by Pavel Pertsev (morhetz),
  MIT/X11.
- Everforest (https://github.com/sainnhe/everforest): Copyright (c) 2019
  sainnhe.
- Nord (https://github.com/nordtheme/alacritty): Copyright (c) 2016-present
  Sven Greb.
- Dracula (https://github.com/dracula/ghostty,
  https://github.com/dracula/visual-studio-code): Copyright (c) 2023 and
  2016 Dracula Theme.
- GitHub (https://github.com/primer/github-vscode-theme,
  https://github.com/primer/primitives): Copyright (c) 2020 Primer,
  Copyright (c) 2018 GitHub Inc.
- Nightfox / Carbonfox (https://github.com/EdenEast/nightfox.nvim):
  Copyright (c) 2021 James Simpson.
