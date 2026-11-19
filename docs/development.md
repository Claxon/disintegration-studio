# Disintegration Studio — Development

Disintegration Studio is a Photoshop [UXP](https://developer.adobe.com/photoshop/uxp/) plugin written in plain JavaScript, with no dependencies. Its engine is also compiled from Rust to WebAssembly for speed; the compiled module is committed, so building and packaging the plugin needs only PowerShell, and Node for the tests (see [The WebAssembly engine](#the-webassembly-engine)).

## Layout

```
disintegration-studio/          the plugin
  manifest.json                 UXP manifest (id, version, the three menu commands)
  index.html                    the dialog markup
  styles.css                    the dialog styles
  ui-controls.css, ui-tips.css, ui-previews.css   styles of the settings column
  js/disintegration-core.js     the engine: erosion, particles, preview compositing (no host APIs)
  js/engine-wasm.js             loads the WebAssembly engine and switches the core over to it
  js/engine-wasm-bin.js         the compiled WebAssembly module, as base64 (generated)
  js/presets.js                 the built-in presets
  js/ui-raster.js               tiny raster drawing for the pictures in the settings (UXP has no canvas)
  js/ui-controls.js             the cards, sliders, switches, dial and tabs of the settings column
  js/ui-tips.js                 the brush tip mix bar, gallery and library
  js/ui-previews.js             the live pictures on the Particles, Motion and Look tabs
  js/main.js                    the dialog: state, preview, painting, and the Photoshop bridge
  icons/                        plugin icons
engine-wasm/                    the Rust source of the WebAssembly engine
installer/                      Windows install / uninstall scripts shipped in the release zip
tools/
  build.ps1                     builds dist/DisintegrationStudio.ccx and the installer zip
  build-wasm.js                 builds the WebAssembly engine and writes engine-wasm-bin.js
  bench-engine.js               times the JavaScript and WebAssembly engines against each other
  serve.js                      static server for running the UI in a browser
  make-icons.js                 regenerates the icons (with the engine)
test/engine-test.js             headless checks for the engine; writes pictures to test/out/
test/ui/                        browser pages for the settings controls, previews, tip mix and engines
docs/                           the user guide, this file, and the pictures they use
```

## How it fits together

### The engine (`disintegration-core.js`)

Exposes `Disintegration` (on `window` or `globalThis`). It takes a **subject** (RGBA; its alpha is the cut-out) and, for previews, a **plate** (the picture with the subject removed).

- `prepare(src)` analyses the subject once: bounding box, centre, area, and a 512-pixel analysis grid holding the downsampled alpha and the distance to the subject's edge.
- `render(ctx, state, opts)` returns an **erosion map** (how much of each subject pixel is removed) and a **particle layer** (RGBA).
  - A *progress field* on the grid says how early each part of the subject goes: by distance behind the start point (`sweep`), distance from it (`point`), or distance from the edge (`edges`).
  - A *paint field* on the grid holds the brush strokes (+1 disperse, −1 protect; a stroke's `flow` scales it). Strokes are stored as lists of points, as fractions of the image. `paintLevels()` turns it into two levels, `add` and `keep`, and lets each fade out over the **Blend** distance beyond the edge of the paint (`spread`, a two-pass chamfer).
  - Paint works on the same depth scale as the automatic dispersion. `add` gives a depth of its own that grows with the level; `keep` puts a ceiling on the depth, down to nothing where it is solid. The sampler also returns `calm` (0…1): across a fade, pieces are made smaller and thrown less far.
  - Progress plus fractal noise, measured against a threshold set by **Amount**, gives each spot a *depth*: how long ago the dispersion front passed it, in band widths. Below 0 the front has not arrived; from 0 to 1 pieces leave one by one; from 1 to 1.5 every piece has left; beyond 1.5 the mask is simply solid (`makeSampler`, `erodePass`).
  - `pieces()` scatters candidate pieces over the subject, enough to cover it about one and a half times. A piece that has left stamps its brush tip into the erosion map (`stampHole`) and is drawn with the same tip as a particle (`stampPiece`), carrying the picture from where it was cut. So every hole in the band has its piece. **Density** only thins the pieces from the solid part, whose holes have merged.
  - Each piece takes its colour from the subject where it started and travels along the direction with spread, burst, curl-noise turbulence and gravity.
- **Brush tips** (`TIPS`) are formulas, not pictures, so they are sharp at any size: an outline given as a radius for each of 96 directions, optionally stretched, with droplets, a soft edge or a dry-brush grain. Each has 8 variants. `tipAlpha()` gives the coverage at a point; pieces under 3 pixels are drawn as plain dots. Tips of the user's own (`setCustomTips`) are small bitmaps, made from a selection (`tipFromMask`) or from a picture's transparency or dark parts (`tipFromImage`). A design holds the mix as `tips: { id: weight }`; the single `shape` of earlier designs is converted.
- `composite(ctx, res, opts)` builds the preview picture; `drawOverlay` draws the arrow and the selection box into the pixels (UXP has no canvas to draw them on).
- `split`, `inpaint`, `dilate`, `halve` are helpers for hosts: cut a flat picture into subject + roughly filled plate, and make half-size drafts.

**Speed.** Most of a render goes into the pieces: deciding which have left (`makeSampler`'s `at()`, with its noise) and stamping each one's hole and particle (`tipAlpha` for every pixel). `tipAlpha` reads a tip's outline from a table (`tipTable()`, 128×128 per variant, built when first used), and only where the table can't be sure (a pixel on the anti-aliased edge, judged by the steepest slope around that cell) does it work the outline out exactly, so the result matches the exact one to within 1/255. `stampHole` skips pixels already fully eroded, and the erosion pass bounds a painted pixel's depth over the whole range of the noise before working the noise out.

**Resolution independence.** Lengths are measured in *subject units* (the square root of the subject's area), every random number is hashed from the particle's index, and erosion is evaluated from the grid fields and noise at exact positions, not read from pixels. `render` returns `resolved.ref` (direction, start point, scale and bounding box as fractions of the image); passing it back as `opts.ref` pins a render at another size to the same layout. The dialog does this so the full-size result matches the preview.

### The dialog (`main.js`)

Holds the effect state (`fx`), builds the controls from a schema (`SECTIONS`), handles the mouse on the preview, and talks to the host through a **bridge**:

| Call | What it does |
| --- | --- |
| `begin({ subject, box, quality, fill })` | Picks the subject (`init`, `auto`, `box`, `layer`, or `keep` to leave it alone) and returns preview buffers. |
| `generate()` | Builds the layers now. |
| `apply(fx, ref)` | Builds the layers if needed, renders at full size, writes the mask and the particles. |
| `quick(fx, fill)` | The whole thing with no dialog. |
| `captureTip()` | A brush tip (`{ n, data, from }`) from the selection, or else from the active layer. |
| `cancel()` / `end()` | Undo the session / finish it. |

**Precision.** `rangeField()` builds every slider with its number box. In fine mode (`ui.fine`, the Fine button) it gives the slider a window of a tenth of the setting's range around the current value and a step a tenth of the size, and moves the window along when the slider is let go near either end. The number box applies on `input` as well as `change` and handles Up / Down itself (Photoshop's number boxes don't). Fine mode also scales the drags of the aim handles on the preview by `FINE_DRAG`. A range marked `whole` (Seed) is left alone.

Photoshop refuses to read or write pixels while a modal dialog is open, so anything that touches the document closes the dialog with a reason (`ok`, `apply`, `generate`, `quality`, `subject:box` …), does the work, and reopens it. See `openStudio()`.

**Preview speed.** The dialog keeps the scene at three sizes: the preview's own, a half and a quarter (`levels()`).

- A picture shown at `SMALL_BELOW` of its size or less is rendered at half size (`shownSmall()`). On screen it looks the same and it takes about a quarter of the time. Zooming across that line renders it again at the other size.
- While something is moving, each frame is drawn at the largest size whose last render (or a quarter of the size above's) took no more than `DRAFT_MS`, down to a quarter. A render blocks the whole dialog, scrolling included, so a slow frame makes everything lag. The proper render follows 240 ms after the last change, or as soon as a brush stroke or a handle drag ends (`settle()`); one that is still held waits for the mouse to come up.
- The Mask view renders with `noParticles`.
- Only the open tab of settings is laid out (`showTab()`), and only its live pictures are redrawn (`syncPreviews()`).
- `commit()` writes the settings to `localStorage` 500 ms after the last change (`saveSoon()`), and at once when the dialog closes: with paint strokes they are large.
- The brush outline is laid over the preview (`placeRing()`), not part of the picture: a container holding a CSS ring for the brush edge and one picture (`#ringDashes`) for the dashed and dotted rings, since Photoshop draws dashed CSS borders as solid lines. A mouse move only moves the container, by a position worked out from where `layout()` put the picture (`v.place`) rather than measured; the rings are made again only when the brush, the zoom or Blend changes. A burst of moves is drawn once, by a short timer (`requestAnimationFrame` isn't documented for UXP dialogs). While a stroke or a handle is dragged, renders are spaced `DRAG_GAP_MS` apart so the outline can be drawn in between. Photoshop sends no hover moves from automated pointer moves, so the outline can only be checked by hand or during a drag. The aim arrow is still drawn into the pixels; the picture is only encoded again when it or the arrow has changed.
- When the dialog closes it writes a `preview timing` line to the log: frames, average render, composite and encode times.

Settings live in `localStorage`: `disintegration.state.v1` (last look), `disintegration.userPresets.v1`, `disintegration.ui.v1`, `disintegration.customTips.v1` (the user's own tips, base64), and `disintegration.fx.<key>` per applied effect, where `<key>` is the tag in the layer group's name (`Disintegration #<key>`).

### The Photoshop bridge

- **Session.** `begin` records the document's history state; `cancel` returns to it. Nothing is built until it has to be: the first preview is made from the flat picture, the selection and `split()`.
- **Subject.** An existing selection, else Select Subject (`autoCutout`). Box select tries the Object Selection tool's rectangle (`set selection` with `deepSelect`) and, if Photoshop returns a plain rectangle or fails, falls back to Select Subject clipped to the box.
- **Layers** (`build`). Reads the selection and the flat picture at full size; expands the selection and fills it on a new layer (Generative Fill via `syntheticFill`, else Content-Aware Fill on a copy of the picture masked down to the patch); writes the subject, with the selection as its alpha, to a *Subject* layer; adds an empty *Particles* layer; groups them.
- **Apply** (`write`). Reads the *Subject* layer, renders, writes the inverted erosion map with `imaging.putLayerMask` and the particles with `imaging.putPixels`.
- **Editing.** If the active layer is, or is inside, a `Disintegration #…` group that has a *Subject* layer, `begin` reuses it. The plate is the document read with *Subject* and *Particles* hidden.

### Things that rest on undocumented Photoshop behaviour

These calls come from recorded action descriptors and community examples, not from Adobe's reference. Each has a fallback and logs what happened to `disintegration-log.txt`. The last column is what happened on Photoshop 26.8.1 (Windows), on a 3072×4080 8-bit RGB photo:

| Call | If it fails | Photoshop 26.8.1 |
| --- | --- | --- |
| `syntheticFill` (Generative Fill). Three descriptor variants are tried. | Content-Aware Fill, with a note in the dialog. | The first variant (`gi_MODE: "ginp"` with `serviceVersion: "clio3"`) worked both times; 14–18 s. |
| `set selection` with `deepSelect` (Object Selection in a rectangle) | Select Subject clipped to the box. | Worked: a box round the statue selected the figure and not its plinth. |
| `make … revealSelection` to mask the Content-Aware patch | The fill layer stays a whole-picture copy. | Worked. |
| `putLayerMask` on a layer with no mask yet | A mask is added with `make … revealAll`, then written. | Worked without the fallback. |
| `resumeHistory(id, false)` to discard the visibility toggles used while sampling | The toggles stay in the history; visibility itself is always restored. | Not checked. |

It also relies on `imaging.getPixels` with a `layerID` returning the layer's pixels without its layer mask applied (the *Subject* layer is re-read this way when an effect is edited). That held: reopening an applied effect showed the whole subject.

### Photoshop quirks the code works around

- **Dialog height.** UXP grows a modal dialog to fit its content, whatever size was asked for. `sizeColumns()` gives the columns explicit pixel heights before the dialog is shown, `#scroll` has a default CSS height, and `layoutAll()` lays out to the requested height if the first measurement is much taller. The dialog element is only as tall as that content, so it does not grow when the user drags the window taller (its width does follow the window), and UXP has no `window.innerHeight`. `layoutAll()` reads the window height from `#heightProbe`, a hidden element 100vh tall.
- **Dropdowns.** UXP puts a dialog's `<select>`s back to their first option each time the dialog is shown. `syncSelects()` rebuilds them from the settings before every show and sets them again just after.
- **Native controls draw on top.** A `<select>` (and other native widgets) is painted above any HTML laid over it, whatever the z-index. The brush tip library sheet hides the native controls under it while it is open (`onLibrary` in `renderInspector`).
- **Opacity on images and their parents is ignored.** Dim a picture by drawing it in a darker colour (see the "In the mix" thumbnails in `ui-tips.js`), not with `opacity`.
- **Escape always closes the dialog.** Photoshop cancels the modal before the page can stop it; preventing the dialog's `cancel` event does not help. So Escape with the tip library open closes the whole dialog (as Cancel).
- **Hidden active layer.** Select Subject and Object Selection are unavailable while the active layer is hidden, even though they sample all layers. `useVisibleLayer()` makes a visible layer active first.
- **Scaled reads.** `imaging.getPixels` with a `layerID` and a `targetSize` returns the layer's own bounds stretched to that size, and `sourceBounds` is in the coordinates of the pyramid `level` that was read. `unpack()` maps by `sourceBounds` on each axis separately.
- **16-bit documents.** `imaging.getPixels` asked for 8-bit data fails on a 16-bit document ("Could not convert the image"). `readPixels()` asks for 16-bit data there and `unpack()` scales it down. The effect is computed from 8-bit values and written back as 16-bit.
- **Pictures in the dialog.** There is no canvas, so the tip thumbnails are PNG data URLs made with the plugin's own tiny encoder (`encodePng`). UXP draws every `<button>` as a wide pill, so the delete control on a custom tip is a `<span>`.
- **The mouse wheel.** Photoshop does not send the wheel to what is under the pointer. It sends it to whatever has the keyboard focus: with nothing in the dialog focused, the document behind the dialog scrolls or zooms; with a number box or slider focused, that setting changes. No `wheel` event reaches the page either way. So the dialog keeps the focus on a number box of its own that is out of sight (`#wheelCatch`) and reads the wheel from the way the box's value moves, one notch being a step of 0.1 (`readCatcher()`). `holdFocus()` takes the focus back after a button press, a slider drag or a dropdown choice, but leaves it with a field the user is typing in. A dialog that has just opened does not have the keyboard at all until the dialog element itself is focused. The first few turns of each session and the changes of focus are logged.
- **Where the pointer is.** Photoshop reports the pointer while it moves over the preview, but sends no `mouseleave` when it goes, and little or nothing while it is over the settings list. `stillOverPreview()` works leaving out from where the pointer was last seen and how fast it was heading for an edge. Automated clicks that jump straight to a button without crossing the dialog can leave the preview hearing nothing until it is clicked.
- **Scrolling from a script.** `scrollTop` is not kept within the list, and the number boxes are not redrawn when it changes. `wheelTurn()` clamps it and nudges the layout (a different bottom padding each time, put back when the wheel stops).
- **Uninstalling wipes the plugin's storage.** Removing the plugin deletes its `localStorage`: saved presets, custom tips, the last look and the background preference (which goes back to Generative Fill).
- **Reinstalling while Photoshop is running.** Photoshop loads a newly installed plugin without a restart, but installing the same version over itself does nothing: remove it first (`UnifiedPluginInstallerAgent /remove "Disintegration Studio"`). The first command run straight after a hot reinstall can fail once.
- **Updating.** Installing a higher version over the installed one keeps the storage, but the running Photoshop goes on using the old version until it is restarted. To try a build in a running Photoshop without touching the installed plugin or its storage, package it under another `id` and `name` in the manifest and install that beside it. Adobe's installer does not always retire the old version: `%APPDATA%\Adobe\UXP\PluginsInfo\v1\PS.json` can list both as `enabled`, and Photoshop then loads the first one, the old one, after every restart. So `installer/install.ps1` waits for Photoshop to be closed and sets every other version's `status` to `uninstalling` (what the installer normally does); Photoshop deletes those at its next start. Don't use `/remove` for this: it wipes the storage.
- **Installing a lower version.** Adobe's installer refuses to install a version lower than one that is installed (status -418), even when the higher one is marked `uninstalling`. The plugin has to be removed first, which wipes its storage.
- **Measuring the layout.** Photoshop lays a dialog out again only when the script returns, so an element's size read straight after changing its style (or its parent's width) is the old one. The tab row (`tabs()` in `ui-controls.js`) measures the width its names need once, while they are showing, and is told the column's new width rather than measuring it.

## Running the UI in a browser

```bash
node tools/serve.js
```

Then open <http://localhost:5179/disintegration-studio/index.html>. There is no Photoshop to find a subject or fill a background, so:

- the built-in demo scene comes with its own subject and background;
- any other picture (**Choose file**, or `?img=<url>`) gets an oval "subject" in the middle, or in the box you drag with **Box select**, and the quick fill.

**Apply** and **OK** download the result as a PNG (add `?nodownload` to skip that). `window.__disintegration` exposes the state for poking at from the console.

## Tests

```bash
node test/engine-test.js
```

Checks the engine against a synthetic scene: amount limits, the side the erosion is on, determinism, particle colours coming from the subject, painting / protecting / erasing, the dispersion tapering off towards protect paint with Blend, a half-strength brush, a 2× render matching the preview, every pattern, preset and brush tip, holes matching their pieces, a custom tip made from a mask, the tip outline table against the exact outline, and the helpers. It writes each picture and a contact sheet (`sheet.png`) to `test/out/`.

The Photoshop bridge has no automated tests. Check it by hand in Photoshop:

- Quick Disintegrate.
- The dialog: subject found automatically, from your own selection, by Box select, and by Use layer.
- Each background method, then **Build now**.
- Aim, a preset, each brush, the *Mask* view, the **Brush tips** sliders, **Blend** and **Brush strength**.
- **Fine**: a slider drag, letting go at the end of a slider, a typed decimal, Up / Down and the wheel in a number box, dragging the arrow tip.
- The mouse wheel: over the preview straight after the dialog opens, after pressing a button, after dragging a slider and after painting; over the settings, at both ends of the list. Typing in a number box and choosing from a dropdown afterwards.
- **New Brush Tip from Selection or Layer** with a selection, with a cut-out layer and with an opaque image, then using and deleting that tip.
- **Apply**, **OK**, **Cancel** (the document should be exactly as it was), and reopening an applied effect to edit it.
- An 8-bit and a 16-bit document.

Checked on Photoshop 26.8.1 (Windows): all of the above except Use layer, the *None* background, and a brush tip from a cut-out layer. Generative Fill was checked on an 8-bit and a 16-bit document.

## Running in Photoshop

Load `disintegration-studio/manifest.json` with Adobe's **UXP Developer Tool** for live reload and the debugger, or build and install the package as below.

The plugin writes a diagnostic log to
`%APPDATA%\Adobe\UXP\PluginsStorage\PHSP\<version>\External\com.claxo.disintegrationstudio\PluginData\disintegration-log.txt`.

## Building

```powershell
powershell -File tools/build.ps1
```

This writes `dist/DisintegrationStudio.ccx` (the plugin package) and `dist/DisintegrationStudio-<version>-Installer.zip` (the package plus the install scripts). Both include `LICENSE`. The version comes from `manifest.json`.

To install the build locally:

```powershell
powershell -ExecutionPolicy Bypass -File installer/install.ps1 -Ccx dist/DisintegrationStudio.ccx
```

## Releasing

[`.github/workflows/release.yml`](../.github/workflows/release.yml) builds a GitHub release when a `v<version>` tag is pushed: it checks the tag matches `manifest.json`, syntax-checks the scripts, runs the engine test, runs `tools/build.ps1`, and publishes both files from `dist/` with that version's `CHANGELOG.md` section as the notes.

1. Bump `version` in `disintegration-studio/manifest.json` and add a `## <version>` section to `CHANGELOG.md`.
2. Commit, tag the commit `v<version>`, and push both.

## The WebAssembly engine

The hot part of a render is also compiled from Rust to WebAssembly, and the plugin uses that when it can. It gives exactly the bytes the JavaScript engine gives, in about half the time. The JavaScript engine stays as it is: it is the reference, and the fallback.

```
engine-wasm/                    the Rust crate (no dependencies, no wasm-bindgen: plain extern "C" and pointers)
  src/lib.rs                    erodePass, pieces (the sampler, stampHole, stampPiece, tipAlpha), finishErosion, composite
disintegration-studio/js/
  engine-wasm-bin.js            the compiled module as base64 (generated, committed)
  engine-wasm.js                loads it and switches Disintegration.render / composite over to it
tools/build-wasm.js             builds the crate and writes engine-wasm-bin.js
tools/bench-engine.js           times the two engines against each other
test/ui/wasm-engine.html        the same comparison in a browser (node tools/serve.js)
```

**What runs where.** `render()` still works out the direction, the grid fields and the paint levels in JavaScript (`resolve`, `renderFields`), and the numbers the passes use (`samplerParams`, `pieceParams`, `tipMix`); the core hands these to `engine-wasm.js` through `Disintegration._core`. The module does the three passes over the pixels and the preview composite. The brush tips are built in JavaScript as before (`tipVariants`, `tipTable`) and copied into the module the first time a render uses them; the module keeps them, keyed by the variants list, so a custom tip set again is copied again.

**Loading.** The scripts load in the order `disintegration-core.js`, `engine-wasm-bin.js`, `engine-wasm.js`. The module is compiled when the script runs: at once where the host allows it (Node, UXP, the desktop app's browser pane), else in the background (a browser's main thread refuses to compile more than 4 KB at once), and until then renders use JavaScript. Base64 is decoded by the script itself (UXP may have no `atob`).

- `Disintegration.engine` is `'wasm'` or `'js'`; `Disintegration.useWasm(false)` forces JavaScript, `useWasm(true)` goes back (and loads the module again after a failure).
- `Disintegration.wasmReady` is a promise of the engine's name once loading has settled; `Disintegration.engineInfo()` gives its status, how long it took to load, its memory and how many tip variants it holds.
- Any error in the module (or in loading it) switches the session to JavaScript for good and is reported once, to `Disintegration.engineLog(message)` if the host has set it, else to the console. The render that failed is done again in JavaScript.
- A custom tip whose data are not whole bytes can't be copied exactly; renders that use it are done in JavaScript.

**Exactness.** Every number is an f64, every expression is evaluated in the JavaScript's order, `Math.imul` / `>>>` / `| 0` are wrapping integer operations, a store into a `Uint8Array` truncates and one into a `Uint8ClampedArray` rounds half to even. `Math.sin`, `cos`, `pow` and `atan2` are imported from the host: V8's results differ in the last bit from Rust's (its `sin` and `cos` changed between V8 builds, and its `pow` is not the one Rust's libm has), so the module calls the host's own. `Math.hypot` is V8's algorithm (Kahan summation of the scaled squares), written out. The module also takes a few shortcuts the JavaScript doesn't, each of which provably gives the same answer: whole grid quads of the erosion pass that are nowhere near the front, a cache of the noise's lattice hashes, droplets too far away to count, points well inside or outside a tip's outline (no `atan2`), the run of each stamp row that can pass the stamp's own test, and plain pixels of the composite copied as whole numbers.

**Memory.** One instance; its buffers (subject, erosion map, particles, plate, composite) are kept and grown as needed, and the results are copied out into fresh arrays, as the JavaScript engine returns them. A 957×1600 preview with its half and quarter sizes takes about 35 MB. The module's memory can only grow, so after a call that leaves it above 128 MB (a full-size render) the instance is dropped and a new one started.

**Changing the engine.** Any change to the ported JavaScript (`samplerParams` / `makeSampler`, `pieceParams` / `pieces`, `stampHole`, `stampPiece`, `tipAlpha` / `tipTable` / `tipAlphaExact`, `erodePass`, `finishErosion`, `composite`, the noise) has to be made in `engine-wasm/src/lib.rs` as well. The parameter blocks are laid out in the same order in `lib.rs` (`mod p`, `mod th`) and `engine-wasm.js`. Then:

```bash
rustup target add wasm32-unknown-unknown   # once
node tools/build-wasm.js                   # cargo build --release, then writes engine-wasm-bin.js (commit it)
node test/engine-test.js                   # section 11 compares the two engines byte for byte
```

`node tools/build-wasm.js --check` fails if the committed `engine-wasm-bin.js` is not what the source builds (with the same Rust version). `ENGINE=wasm node test/engine-test.js` runs every check of the engine test on the WebAssembly engine. Section 11 compares the engines on every preset and brush tip, custom tips (from a mask, from a picture, as a plain array), paint of every kind with and without Blend, every pattern, burst, turbulence, gravity and trails, `noParticles`, a 2× render pinned to the preview, a small odd size and a scene with no plate, and every composite view; it also checks `useWasm`, the fallback after an error, and a tip it can't copy.

**Speed.** In Photoshop 26.8.1, on a 1000×563 preview, a full render took 22 ms against the JavaScript engine's 33 ms, and a frame while dragging 16 ms against 21.5 ms. In Node (`node tools/bench-engine.js`, Node 22, render + composite over six presets with and without paint): 957×1600 about 1.95× faster (renders 1.7–2.6×, composites 1.4–2.6×), 479×800 about 1.8×, a 3072×4080 render 470 ms → 254 ms. Most of what is left is the stamps' per-pixel work and the particles' turbulence, which both engines do the same way.
