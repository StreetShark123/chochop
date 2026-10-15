# Contributing to chop chop

Thanks for wanting to make chop chop better! Ideas, bug reports, translations and code are all welcome.

## Ways to help

- **Report a bug** — [open an issue](https://github.com/StreetShark123/chochop/issues/new/choose) with your browser and OS, what you did, what you expected and what happened. If it's about a specific file, mention its format (WAV, MP3…), length and sample rate.
- **Suggest an idea** — open an issue describing the problem it solves before writing code, so we can agree on the approach.
- **Improve a translation** — all interface text lives in [`i18n.js`](i18n.js), in Spanish (`es`), Galician (`gl`) and English (`en`).
- **Send code** — fork the repo, create a branch, and open a pull request. Small, focused changes are easiest to review.

## Running it locally

No build step, no dependencies:

```sh
python3 tools/serve.py
# open http://localhost:8000
```

`tools/serve.py` sends the same security headers as production (read from `vercel.json`). Please test your change with it: if something works with a plain static server but breaks here, the Content-Security-Policy is blocking it.

## House rules

1. **Privacy first.** No analytics, cookies, trackers, third-party scripts, fonts or APIs, and no network requests of any kind. Everything must keep running in the browser. The Content-Security-Policy in `vercel.json` (including `connect-src 'none'`) is part of the product and must not be loosened.
2. **No dependencies, no build.** Plain HTML, CSS and ES modules, served as they are.
3. **Three languages.** Any visible text goes in `i18n.js` in `es`, `gl` and `en`. If you don't speak one of them, say so in the PR and it will be filled in.
4. **Match the existing code.** Same style, naming and comment density as the surrounding code. Keep pure logic (no DOM) in `dsp.js`.
5. **Check before you send.** Load a file, dig, chop, play in order and shuffled, and download a ZIP — with the browser console open and no errors.

## Ownership and license

chop chop is created and maintained by **StreetShark123**, who reviews contributions and decides what gets merged.

By submitting a contribution you agree that it is published under the project's [MIT license](LICENSE). Your authorship stays in the git history.

The name **chop chop** and its logo identify the original project. You're free to fork it and publish your own version under the MIT license — please just give it a different name so it isn't confused with the original.
