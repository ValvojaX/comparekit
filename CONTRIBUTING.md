# Contributing

```sh
npm install
npm run build              # dist/extension.js, dist/webview.js and dist/webview.css
npm run typecheck
npm test                   # unit tests (vitest)
npm run test:integration   # runs the extension in a downloaded VS Code against a scratch git repo
npm run harness            # every view with sample data at http://127.0.0.1:47613/test/harness/out/
npm run package            # .vsix
```

Press F5 in VS Code to start an Extension Development Host.

```
src/core/      pure logic, no VS Code imports: CSV, table diff and merge, Excel, ZIP, bytes, folders
src/           extension host: commands, dispatcher (compare.ts), git, custom editors, views
webview/src/   React UI for every view, one bundle; ui/ holds the shared components and styles
test/          unit tests, integration suite, browser harness
```

Design rules for the views:

- Colors come only from `webview/src/ui/tokens.css`, which maps every token to a VS Code theme variable.
- Diff meaning is the same everywhere: left/removed uses git's deleted color, right/added git's added color, changed git's modified color, conflicts git's conflicting color.
- Webviews get data only by message (`src/shared/protocol.ts`) and load nothing but the bundled script and stylesheet.
- The extension makes no network requests and starts no processes.

Every push to `main` (and every pull request) runs the typecheck and both test suites on GitHub Actions and uploads the `.vsix` as a build artifact (`.github/workflows/build.yml`).
