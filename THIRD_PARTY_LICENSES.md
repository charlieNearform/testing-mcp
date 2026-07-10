# Third-Party Licenses

This project includes source code adapted (vendored) from third-party open-source
projects. Their license notices are reproduced below as required.

---

## testpick

- **Project:** testpick
- **Author / Copyright holder:** Kazutaka Sugiyama
- **Source:** https://github.com/TwistTheoryGames/testpick (npm: `testpick`)
- **License:** MIT
- **What we use:** the single-pass V8 precise-coverage snapshot-diff *attribution
  algorithm* (mapping each test file to the source files it executed), ported and adapted
  to run inside this project's per-project coverage worker. We add setup-baseline
  subtraction and our own daemon/worker/state integration on top.
- **Vendored location:** any file containing ported testpick code must carry a header
  pointing back to this entry (see template below). Update this section if the vendored
  version changes.
- **Vendored version reference:** testpick v0.1.1 (verify commit/version at import time).

```
MIT License

Copyright (c) 2026 Kazutaka Sugiyama

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

### Vendored-file header template

Add this header to the top of any source file that contains ported testpick code:

```ts
/*
 * Portions of this file are adapted from testpick (https://github.com/TwistTheoryGames/testpick)
 * Copyright (c) 2026 Kazutaka Sugiyama — MIT License.
 * See THIRD_PARTY_LICENSES.md at the repository root for the full license text.
 */
```
