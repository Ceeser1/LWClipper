# Changelog

The most important changes since 1.5.5, newest first.

1.5.5 (2026-09-16, tag `v1.5.5`) was the last version that was only a single-clip trimmer: paste a link or open a file, trim it, crop it, save it. That trimmer is still in the app as simple editing. Everything below was built on top of it as advanced editing, a multi-track editor in the same window.

## 5.x: VFX (2026-11-17, 2026-11-18)

Current version: 5.1.6.

- **The headings of the VFX list fold (5.1.6).** A click on **Blur and Hide**, **Color**, **Stylize** or **Distort** in the VFX window folds its VFX away under the heading, and another click brings them back, so the list need not be scrolled through from top to bottom. Which headings are folded is remembered, for every project and the next start. The search still looks through all of them: while something is typed, a folded heading opens for what was found under it, and it is folded again once the search is empty.
- **A small image stays small, and Crop and Mask has its settings on top (5.1.5).**
  - **An image no bigger than the frame is shown at its actual size**, centred, when it is added, instead of being blown up to fill the frame: a 256 x 256 picture in a 1080p project is 256 x 256 pixels in the middle. An image bigger than the frame is still fitted down, and a video still fills the frame. In **Render Position** such an image reads "Centred at actual size", its **Scale** of 100% is its own pixels, and **Reset Position** brings it back there. Images already on a timeline, and projects saved before, stay exactly as they were.
  - **Crop and Mask** has each view's settings over the picture and the keyframes under it, as the other windows have them. **Video Frame:** the shape buttons, the size in pixels, the Zoom slider, the picture, the keyframes. **Render Position:** the size and place, the Scale slider, the picture, the keyframes.
  - **Fixed:** dragging the playhead on the keyframe bar of Render Position, between two keyframes where the picture differs in size, left a new keyframe at every step of the drag. Moving the playhead makes none now; changing something between two keyframes still makes one there.
- **A crosshair for Bulge, Swirl and Kaleidoscope (5.1.4).** These three bend the picture about a point, and a Bulge and a Swirl already say how far they reach with their Radius, so a box on top of that was a second way to say the same. They now show a crosshair on the picture: drag it to where the effect should sit. It lands on the picture's middle and edges, stays on the picture, and is also there as two figures, **Center X** and **Center Y**. With keyframes the point travels like any other setting. One that was saved with an area stays about that area's middle.
- **Each VFX only has the area settings that make sense for it (5.1.3).** Until now every VFX had an area of any of the eight shapes with a soft edge, also where a part of the effect means nothing. Now:
  - **The whole picture, nothing to place:** Cinema Bars, Border, Old TV, Lens Distortion, Flip and Mirror, Rotate, Offset, Perspective, Shake, Tile. What they do is told by the picture's own frame.
  - **A box** to move, size and turn, with Invert Area and Soft Edge, and no choice of shape: the looks and tints (Black and White, Sepia, Colorize, Duotone, Split Toning, Color Pass, Film Look, Apply LUT, Channel Swap, Invert Colors, Glow, Dream, Film Grain, Old Film, VHS, Comic, Scanlines, RGB Split, Posterize, Threshold, Solarize, Edge Detect, Emboss, Night Vision, Thermal Camera) and Wave and Glitch.
  - **A rectangle or a circle:** the VFX one aims at a thing in the picture, a face, a sign, a fire: Brightness and Contrast, Exposure and Gamma, Levels, Shadows and Highlights, Hue and Saturation, Temperature and Tint, RGB Balance, Sharpen, Clarity, Vignette, Directional Blur, Tilt-Shift, Zoom, Ripple, Heat Haze.
  - **Every shape:** only Obscure and Pixelate, which cover a thing up.
  - **Soft Edge** is gone from Zoom and Glitch: both move the picture far, and a fade between moved and unmoved showed the thing twice.
  - A project saved before keeps its VFX: a shape a VFX no longer offers becomes the one it starts with, and an area a VFX no longer has is dropped, so it acts on the whole picture.

- **Switch a VFX off and on (5.1.2).** Each VFX a track has shows a checkbox in front of its name. Untick it and the VFX is off, in the preview and in the export, without removing it or changing its place, so the picture can be compared with and without it; its name is struck through meanwhile. Ticking it again brings it back as it was. Like every change in the window it reaches the track with Apply, is kept with the project and goes along with Copy VFX.
- **The VFX window, rearranged (5.1.1).**
  - **Available VFX** is a title of its own with a search under it: type part of a name and only the VFX that match are listed.
  - The list is tighter, and each entry's **+** is only the sign.
  - A click on a VFX in the list **previews** it with its defaults, without adding it: the centre says **Previewing [name]** with an **Add** button at its right edge, and its settings can be tried out. Add keeps it as set, its + or a double click adds it too. Clicking another VFX in the list, or one the track already has, drops the preview and what was set in it, and Apply leaves a preview out.
  - The **Editing [name]** line sits right under the track's VFX, below a dividing line, with what the VFX does under it and its settings for the whole clip (green) under that; only the settings per keyframe (white) stay on the right.
  - The track's VFX show their order as **[VFX 1 ×] > [VFX 2 ×] > [VFX 3 ×]**, and only the × is red.

- **Many more VFX (5.1).** The VFX window now lists 57 VFX instead of two, under four headings. Each says in a line what it does, in the list when the pointer rests on it and under its name once added.
  - **Blur and Hide:** Obscure, Pixelate, Directional Blur, Tilt-Shift.
  - **Color:** Brightness and Contrast, Exposure and Gamma, Levels, Shadows and Highlights, Hue and Saturation, Temperature and Tint, RGB Balance, Black and White, Sepia, Colorize, Duotone, Split Toning, Color Pass (one colour kept, the rest grey), Film Look (twelve looks, from Teal and Orange to Noir), Apply LUT (a .cube file of your own, as colour grading tools write them), Channel Swap, Invert Colors.
  - **Stylize:** Glow, Dream, Sharpen, Clarity, Vignette, Cinema Bars, Film Grain, Old Film, VHS, Old TV, Comic, Border, Scanlines, RGB Split, Posterize, Threshold, Solarize, Edge Detect, Emboss, Night Vision, Thermal Camera.
  - **Distort:** Lens Distortion, Bulge, Flip and Mirror, Rotate, Offset, Zoom, Perspective, Wave, Ripple, Swirl, Heat Haze, Shake, Glitch, Tile, Kaleidoscope.
  - Every new VFX starts on the whole picture and has an area like Obscure and Pixelate, so it can be held to a part of the picture, with a shape, a soft edge or inverted: a Vignette is a soft circle turned round, a colour correction can sit on one face.
  - Every new VFX has **Mix**: how much of it shows over the picture as it was. Mix changes between keyframes like the other white settings, and a Mix of 0 switches the VFX off, so an effect can fade in and out or be held to a part of the clip.
  - Almost every figure can change between keyframes: a hue that runs through the rainbow, bars that close in, a lens that bulges and lets go, a picture that scrolls, turns or zooms in. A choice (the look, the palette, the mirror side), a colour and a speed are the same for the whole clip, shown in green like the shape.
  - Wave, Ripple, Heat Haze, Shake and Glitch move by themselves, at the Speed set, on a still picture too.
  - Lens Distortion, Bulge, Zoom, Swirl, Ripple and Kaleidoscope act about the middle of their own area: a Zoom in a small circle is a magnifying glass over what the circle is on, and with keyframes on the area the glass travels; a Swirl on a face turns about the face.
  - **Copy VFX** and **Paste VFX** on a track's right click take a track's VFX to another track, in place of the ones it has: the same look on several clips without making it again on each.
  - The preview shows what the export writes. Each VFX was compared frame by frame against its own export, also keyed, stacked, on a cropped and scaled track and on a picture with see-through parts. Film Grain, Old Film and VHS have their grain at random, so only its strength is the same; lines one pixel fine (Scanlines, Old TV) come out a little softer in the file, as any video codec leaves them.
  - VFX on the whole picture export faster than areas do: twelve stacked on six seconds of 1080p took about seven seconds. Bulge and the ten from Zoom to Kaleidoscope are the exception: the export works them out pixel by pixel, at 1080p about 20 frames a second for Zoom and Wave and 8 to 12 for the others.
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
