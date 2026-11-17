# Changelog

The most important changes since 1.5.5, newest first.

1.5.5 (2026-09-16, tag `v1.5.5`) was the last version that was only a single-clip trimmer: paste a link or open a file, trim it, crop it, save it. That trimmer is still in the app as simple editing. Everything below was built on top of it as advanced editing, a multi-track editor in the same window.

## 5.x: VFX (2026-11-17)

Current version: 5.0.0.

- **VFX (5.0).** Obscure and Pixelate are now VFX, with more kinds to follow. A video or image track has a VFX button beside its settings button, green when the track has VFX, and its right click has **Add VFX** or **Edit VFX**. Both open the VFX window: the list of VFX to add on the left, the track's own VFX with the preview and the keyframes in the middle, the chosen VFX's settings on the right.
  - A track can have any number of VFX, also several of one kind (Pixelate, Pixelate (2), and so on). They are processed in the order shown, and dragging one changes the order.
  - Each VFX has one area and keyframes of its own. Position, size, turn, Strength and Soft Edge can all change between keyframes; the shape and Invert are the same for the whole clip. A Strength of 0 switches a VFX off, so keyframes can limit it to a part of the clip.
  - Nothing changes on the track until **Apply**, and one Apply is one undo step.
  - Projects saved before 5.0 open without their Obscure and Pixelate; they are not converted.

## 4.x: the editor grows up (2026-11-07 to 2026-11-17)

- **Playback and export timing (4.13).** Exporting a selection no longer renders everything before it: ten seconds at minute five took 7.8 seconds and now take about one, and the file is frame for frame the one the long way wrote. During playback a clip is made ready shortly before the playhead reaches it, so the picture no longer stands on a wrong frame for a quarter of a second at a cut and the sound no longer drops out there. Picture and sound are held to the clock while they run: the sound used to start up to 0.18 seconds late after Play and stay behind the picture, and is now within about a hundredth of a second. The Start and End frames are rebuilt only when an edit changes their picture, so most edits no longer hold the preview for most of a second. Fixed on the way: an edit made right after a pause could freeze the preview for ten seconds.
- **A drag follows the selected video (4.12.1).** While the playhead is dragged, the selected video is the one that moves, not the top one: select the full picture under a small one and the full picture is what the drag shows. The other videos appear as black shapes where they lie, cut by their masks; one that would hide most of the frame is shown see-through with an outline instead. Past the end of the selected clip the drag stays on its row. With nothing selected the top video moves, as before, and when the pointer rests every layer shows its frame.
- **Faster, first round (4.12).** Dragging the playhead keeps texts, shapes and images on screen, and when the pointer rests for a moment, with the button still down, every layer shows its frame. A timeline with many clips reacts at once again: an edit at 120 clips took 1.4 seconds and now takes 0.05. Thumbnails of long clips appear several times sooner, and thumbnails and waveforms are kept between runs, so a project opened again shows them at once; Clear cache empties them. A waveform is no longer cut short when two clips are analysed at the same time. Exports with images, masks or Obscure and Pixelate areas are quicker, with the same picture as before. The preview is drawn once per picture instead of once per screen frame, which takes load off the graphics card while playing.
- **One file to hand out, with the installer inside (4.11.2, 4.11.3).** `LWClipper v<version>.exe` asks on its first start whether to install LWClipper or to run it without installing. Installing puts it under Program Files, adds shortcuts and an uninstaller, and makes a double-click on a `.lwc` project open it. Running without installing registers nothing.
- **Opens in advanced editing, maximized (4.11.2, 4.11.3).** Untick **Use advanced Editing** in the settings to get the simple trimmer back; the app then opens in whichever of the two it was left in.
- **Layout kept between runs (4.11.1).** The sizes of the frames and of the window are remembered, a handle sizes Project Media, and F12 restores the default layout.
- **Speed (4.11).** Ctrl and drag on a clip's edge stretches the clip instead of trimming it, from x0.1 to x10, picture and sound together. A right click on the speed figure puts it back to x1.
- **Transitions (4.10).** A fade can be a Wipe, Iris, Clock, Blinds, Dissolve, Slide or Zoom instead, chosen in a Transitions window that shows it running.
- **Fade curves on overlaps (4.9).** Two overlapping tracks show their fade curves as a pair and set them together.
- **Obscure and Pixelate (4.7, 4.8).** Areas of a video or image track can be blurred or pixelated, several per track. Since 4.8 each area can move and change size over time with keyframes of its own. Since 5.0 they are VFX, see above.
- **Text gradients (4.6).** The selected letters of a text can be filled with a gradient.
- **Project Media (4.5).** A frame that lists every source of the project. Its tiles drag onto the timeline, and Add Media brings in new files.
- **GPU export (4.4).** Render using Auto, GPU or CPU. The GPU path needs an Nvidia card and covers MP4 and MOV; everything else renders on the CPU, and Auto falls back to it by itself.
- **Export window, Preferences and Key Binds (4.1 to 4.3).** Export has its own window with name, format, compression and a progress view while it renders. Every shortcut can be rebound in Key Binds. Tracks that sit end to end can be joined into one and un-joined again.
- **Menu bar (4.0).** Advanced editing has a menu bar, and every menu item and shortcut runs off one list of actions.

## 3.x: text, shapes, keyframes and masks (2026-09-25 to 2026-11-07)

- **Text, shapes and colour bars as tracks (3.0 to 3.2, 3.5, 3.6.5).** Text is edited like in a word processor, with font, colour and size per letter. Shapes are circle, square, triangle, star, ring, arrow, heart and speech bubble, with soft edges, outline only, rounded corners and, since 3.7, gradients.
- **Keyframes (3.3, 3.4, 3.6.3, 3.7).** Video, image, text, shape and bar tracks can move, resize and change their crop over time. Keyframes show as diamonds on the clip, with a keyframe strip and a keyframe editor to work on them.
- **Masks (3.6, 3.7.1).** A track can be masked with shapes or with an image of your own, filled with a colour or a gradient. Crop and mask share one window.
- **Editor windows (3.6.2, 3.8, 3.8.2).** The editors open as windows of their own, several at once, and can be docked into Start Frame or End Frame.
- **Fade curves (3.8.1).** Nine curves for a fade, from a right click on the fade's circle.
- **Auto-save and crash restore (3.6.1).** The open project is saved every three minutes, the last five copies are kept, and after a crash the next start offers to restore it.
- **Timeline selection (3.8.2).** Several tracks can be selected at once, Ctrl+A selects all, trim markers snap to track edges, and the timeline scrolls sideways.
- **Opening projects (3.8.4, 3.8.5).** Opening a project while another is open asks whether to save, merge, discard or cancel. A `.lwc` opened from outside goes to the app that is already running instead of starting a second one.
- **Large downloads.** A download of several gigabytes no longer fails at the last step when the finished file is briefly locked by a virus scanner.

## 2.x: advanced editing (2026-09-16 to 2026-09-25)

- **Multi-track timeline (2.0).** Several video, audio and image layers on one timeline, each trimmed, moved, cropped and mixed on its own, and composited into one file. The preview shows what the export will contain.
- **Projects (2.0).** A project is saved as a `.lwc` file that holds the arrangement and points at the media instead of copying it. With undo and redo, grouping, and a Clear cache that spares the media of saved projects.
- **Export with progress (2.0).** Rendering shows its progress, the time remaining and the frame rate.
- **Render frame (2.1, 2.7).** The output resolution is set freely, Render Position places each layer inside it, and the crop of the output may grow past the source.
- **Timeline editing (2.4 to 2.9.1).** Opacity per video layer, fades that snap to the playhead, arrow keys that step one frame, lanes, split with S, copy and paste, and crossfades between overlapping clips.
