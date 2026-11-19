# Changelog

## 1.0.0

First public release.

- **Quick Disintegrate**: one menu command that finds the subject, fills the background behind it, chooses a direction and applies the effect with the look you last used.
- **Open Disintegration Studio…**: one dialog with a large live preview on the left and the settings on the right, on seven tabs: Subject, Paint, Dispersion, Tips, Particles, Motion and Look. **Cancel / Apply / OK** sit at the top of the settings. The dialog can be resized, remembers its size and the tab you last used, and shows the version that is running.
- **Subject**: found with Select Subject, taken from your own selection, picked by dragging a box around it (one person in a crowd, say), or taken from a layer that is already cut out.
- **Background** behind the subject: Generative Fill, Content-Aware Fill, or none. Generative Fill falls back to Content-Aware Fill when it is not available.
- **Automatic dispersion** that chooses the direction with the most room and starts at the subject's leading edge, from one side, from a point or from all edges. Aim it by dragging the start point and the arrow on the preview, or with the direction dial.
- **Paint** regions to disperse or protect, with brush size, edge, strength and **Blend**: paint fades out past its edge, and across the fade fewer pieces leave, they are smaller and they stay closer. The brush outline shows the edge, where the soft edge starts to fade, and how far Blend reaches. The **Mask** view shows what is removed and what is protected.
- **14 brush tips** for the pieces — chips, flakes, crumbs, splatter, grit, ash, slivers, dry brush, petals, smoke, dust, shards, squares and dots — each in several variations, mixed in any proportion with a coloured mix bar and a library to pick from.
- **New Brush Tip from Selection or Layer**: turn any selection, or any image on a layer, into a brush tip of your own (up to 12).
- Every piece bites a hole of its own shape out of the subject, so the holes match the flying pieces. Pieces take their colour, and optionally their picture detail, from the part of the subject they came from.
- Particle, motion and look settings with live pictures of what they do, 14 built-in presets, your own presets, Shuffle, undo/redo, and **Fine** adjustment for precise values.
- **Fast live preview**: the effect is worked out by an engine compiled to WebAssembly (with the same engine in JavaScript as a fallback), and while you drag, paint or aim, the preview draws a quicker draft and sharpens when you stop.
- **Non-destructive result**: a *Disintegration* layer group holding *Particles*, *Subject* (with a layer mask) and *Background fill*. Select it and open the dialog again to edit the effect.
- 8-bit and 16-bit RGB documents.
- One-click Windows installer that makes sure Photoshop loads the version you installed.
