LWClipper V2.X Update plan:

1. Rename current "Video" frame into "Video Overview - Resolution [x] x [y]" as a central header, like "Equalizer". instead of the "Enabled" checkbox put a 2-way select button in the left "Video Overview" and "Equalizer".

2. The "Resolution [x] x [y]" can be changed by 2 dropdowns on the right (the hint "disable video to save audio only" will be removed): Aspect Ratio (e.g. 16:9, 4:3, etc) and Resolution with common resolutions at the picked ratio.
Examples: AR 16:9 has selectable resolutions 3840x2160, 2560x1440, 1920x1080, 1280x720, 1024x576, 854x480, 640x360. I wouldnt go below a certain detail level. The initial ratio/resolution dropdowns get auto-picked by the first source video

2.1 Only if its easily possible make the [x] x [y] as editboxes so the user can also enter custom resolutions

3. Video: Between video overview and audio put the new video frame. Number them e.g. Video 1, 2, 3 with the same size as the audio track frame.
3.1 Each video frame should have several "keyframes" in its bar (same background bar as audio) displayed across its length, e.g. 5 video-frame-images across the default window width, more on higher, less on lower width. Each as the given "video overview" aspect ratio, background filling the height of the bar, with the image of the video-frames position centered in each preview-background at the videos aspect ratio.
3.2 Each video track should be able to be dragged left/right like audio
3.3 Each video track needs a seperate Crop button, showing the white crop-box in the preview-frames of its track.
3.4 On the left, infront of "Video X" show small up/down arrow buttons. Clicking them like "Up" on track 3 exchanges track 3 with track 2, so moving it up, higher in the display-chain. The draw order is backwards like first comes Video 5, then 4, 3, 2, 1 at last rendered on the very top
3.5 After "Video X" put an "[ ] Enabled" checkbox
3.5 On the right show a light red button "Delete" per track which will delete everything in the track if clicked
3.6 Hovering at the edge (start/end) of a track let you shorten/enlength it. To do that the original must of course be kept if it got shortened and only shown less of the source. The video file inside the track must have a clear start/end, so put like a thin box around it
3.8 The last video frame always has a [+] button which will create a new track right below when clicked

4. Audio: Since now multiple audio tracks are possible there is no need for a "Change Audio" button anymore. Instead put the same buttons (Arrows left, Delete/[+] buttons right) for these frames.
4.1 Hovering at the edge (start/end) of a track let you shorten/enlength it. To do that the original must of course be kept if it got shortened and only shown less of the source. And an audio track cannot have an "infinite, thin blue line" before/after it, but must have a clear start and end, so put a thin box around it

5. Keep the Trim section, because it can still cut the overall length of the final rendered video. The first opened/downloaded file determines the max length of all tracks.

6. Each newly created video/audio track shows "No Audio track"/"No Video track" at first. Put an "Open File" button at the left center of the background bar and make each empty track a drag and drop zone. Again, if a video file gets dragged into an audio track, only keep the audio of it.

7. Highlight the current selected/clicked in track with a faint green glow around its frame.





Layer position and scale: You are right, the Crop modal needs to get more detailed. To do that i think 2 distinct frames are the best choice by having a 2-way select button at the top: 1st is the already in-use crop and pan "Video Frame", the 2nd would be "Render Position" where the cropped/panned image can be placed at the desired position for the selected aspect ratio render frame.
The preview has no line in the plan: The preview must show a rough render/audio of the composed tracks, it must not render live at full resolution. Max 30 fps at 854x480 will be fine and it can even drop to lower fps with more layers to consider.
Height: Yes, adding tracks must make the window scrollable/have a scroll bar if the total content height exceeds the window height.
What makes the output audio-only now?: If all video tracks are disabled the "Video preview" automatically switches to the Equalizer and since all video tracks are disabled its only audio left. Of course it must still be sure that at least one audio or video track stays enabled
Per-track volume: Yes, each audio track needs its own volume slider.
Nothing survives closing the app: Yes, that is currently the plan. You finish your work in one go or have to start over.
Quality selection with several sources: A download can only be the first/main source. If another url is being pasted and load/enter on it pressed make a pop-up "Do you want to override the current edits?" - "Yes"/"Cancel" with a hint: "If you want to add another downloaded file to the program, you can start a second instance to download and save it there first before adding it to this project".
Frame-accurate cut stops meaning anything: That toggle can be completely removed if advanced editing is enabled.

Point 5, the first file setting the maximum length: Good point. I think the best choice is that mouse wheel up/down on any track can change the timescale of the tracks and its content being moved to the right can increase the max length. The highest content-ending time determines the total max length.
Point 2 does not say what happens to a source whose aspect ratio differs from the project: Yes, 3.1 answeres it, kinda. The aspect ratio selected in the video overview rules, also in the cropping. So by default simply put a new video track that doesnt match in resolution or aspect ratio in the center of the overview frame. Extending on that: A bigger resolution video source must therefore also be able to be zoomed out if its resolution is higher than the overview. So the Crop modal zoom should go from 10% to 400% instead

What I would do next: I want layering, not sequential. The video clips must be drawn simultaniously if they overlap



What frame rate does the output run at?: Since Frame-accurate cut is gone in the save-frame there is room for a "Framerate:" [dropdown] where you can decide between 15, 24, 30, 48, 60 FPS.
Does a video track's own audio play?: If a video track with audio gets opened/dropped into a video layer, also create a new audio track layer for it.
The 10% zoom belongs to the second tab, not the first: True, the first "Video Frame" renders the video only against the chosen aspect ratio, ignoring the resolution basically. The "Render Position" is where the tracks zoom/scale matters in the final frame.
What shows where no track covers the time?: Yes, a simple black background if there is no video or transparent parts with nothing behind.

Another thing: What about my idea that all tracks live inside the same Video/Audio frame on the app like sony vegas pro has it, so that a jump/click anywhere moves all "current positions" together?




No bump yet.

First we need some bug fixes, adjustments and edits to the current state of v2.
Depending on how expensive you estimate it you can plan this as a part 17/18, because it contains many things at first

Cache clearing:
1. About caching: The normal cache folder is for the simple mode clipper any the "main entry" for cached files in advanced mode too
1.1 When advanced mode gets enabled create a subfolder LWClipper_cache/projects
1.2 When a project gets saved which uses cached files, create a subfolder inside /projects/[projectname]
1.3 When "Clear cache" gets clicked and /projects/ has subfolders or a project in simple or advanced mode is unsaved or not yet exported/saved, create a pop-up warniung.
1.3a If in simple mode and a cache file is opened (check name): "Warning! You are currently working on [name].[extension]. Clearing now without saving first deletes your clip" and below (red)[Clear], (green)[Cancel] buttons.
In simple mode the /projects/ subfolders do not get cleared if some exist.
1.3b If in advanced mode: "Warning! You have cached project files that might be unfinished. Select the cached project files you want to be removed" and then a list of all /projects/ subfolders with a checkbox before their name and [X] MB/GB (summed) on the right
1.3b1 If a cached file is opened in the timeline add another header message additionally "Warning! You are currently working on [cached_files_names_list_in_timeline]. Clearing the cache now removes them."
1.3b2 Again below (red)[Clear], (green)[Cancel] buttons

Advanced mode:
2. The play section button is not working
3. Move the group/crop buttons at the very top right of every track
4. Remove the tracks name. When hovering it it shows the name already, but cut down to name.extention only, dont show the full path
5. Add a light grey "seperator" line with a draggable bar in the center between the preview/equalizer frame and the timeline so that the timeline or preview can be dragged up/down to make more space, but keep the current height in "default or min  window height" as a minimum for the equalizer as well as the preview frame and the current min height for the timeline to display at least 1 video and 1 audio track
6.a When the window gets maximized/restored down find a center between preview-frame and timeline height, but restore the previous if it gets maximized again this session
7. Add a light grey "seperator" line with a draggable bar between "start frame", "preview", "end frame" and these bars are mirrored. If you shrink start frame, end frame also shrinks to the right and the preview frame gets wider. If there is more vertical space available the preview frame can grow larger in general, else simply add the default bars "out of the render frame" to the preview
8. Remove the "Open project" button once an .lwc file got opened or any track got loaded/downloaded. And remove the "Save project" button besides it since its already sitting in the save-frame below



Pospone the proxy media for now, not before v3.X.

Yes, video track fade in/out should affect its transparency so underlying tracks get revealed by that time which can already be used for manual transitions. To enable fading in hover in the left-top corner of the track at the ° symbol which should be rendered above the length dragging slider and shorten the length slider vertically a bit if needed. When hovering °, change the mouse symbol into a ° as well. Click and drag to the right creates a new grey horizontal line on the track with can be dragged. For fade in: A diagonal grey line goes from the bottom left of the tracks start to the top right of the fade-in-end line. For fade-out its reversed, from the top left of the fade-out-start line to the bottom right end of the track. Only linear fading for now, no curves.

Yes, changes made to fading should be undoable.

As for v2.3 i want images to be supported to be a layer like video tracks. When a jpg, png gets opened or dropped, make its default duration 10 seconds. Images must of course also be crop-able. The length of image-tracks can be shortened like video but unline video tracks, the length of images can be extended by dragging its edge further right.


Next Changes/Features for v2.4.x to v2.X:
1. The track alpha bar shouldnt be this blocky, instead a horizontal thin bar like the frame resize bar between preview and timeline but in white and it should be able to completely be on the top and bottom of the video frame (example: overlapping 1px outside the track, 1px on the line, 1 px inside the track  if its 3 px high if you know what i mean).
2. The diagonal fade in/out bar should only get as high as the max alpha bar is. Its angle must change with the max alpha line height so the alpha line height is matched at the fade in/out vertical line that determines fade duration. 
3. Move the fade ° icons closer to the start/end of the tracks and increase their size by 33%.
4. Make the "current position" slider overlap the timeline by 50% of the top knob height.
5. Make Start/End time sliders only dragable at the top while the mouse is above the timelines position and change the cursor to the "hand" like hovering a track so the user sees a difference between hovering start/end and the timeline. Also make their lines below the timeline 50% transparent.
Only in advanced mode:
6. Make the fade in/out sliders snap to the current position slider within a few pixels range
7. In advanced editing only: Remove the title frame (drag and drop zone) since the timeline already has drag and dropable layers and "Unsaved Project" like a possible title already.
8. Add support for arrow left/right pressing which will jump to the previous/next frame (if thats possible without proxy media).
9. Overlay audio/video tracks that are behind the start/end time sliders grey until the sliders
10. An issue i noticed: The cropping below the preview doesnt actually change the render resolution. If the input/start media was 16:9 the preview, and i guess later then output too, gets stretched. Instead that crop button should determine the output render resolution as the main crop. Its already changeable in the editboxes above "preview", but that main crop should change these numbers too.
10.1 To make that more clear, rename the main crop button and window title into "Crop Render" instead of only "Crop"
11 The main crop should have the render resolution editboxes inside the crop window too instead of the pure text "Width x Height", but no layer/track should have them.
12. Add more circles to the "Render Position" tab, on each side centered which place the video centered at each of the 4 sides. Also make the circles a bit smaller and light up green when hovering them instead of grey.

Make update plans and give them version numbers, depending on expected difficulty / finishing time and next git push will be v2.X after my approval. Mainly its changes, so the version number v2.X shouldnt get too high so dont you end up on v2.9 please.

Next planned Fixes, changes and updates:
1. If fade in/out are both used and their vertical lines would collide/overlap, shift the other (non-dragged) further to its side, dont let fade in/out overlap.
2. Hide the "max alpha" horizontal line inside the fade in/out areas, there is already the diagonal
3. Let the End-time slider being dragged past the last tracks end. This simply extends the video with a black screen if there is simply nothing anymore, but it should be possible.
4. When trying to open an image using "Open File" button it says "Error: Images go on the timeline. Turn advanced editing on to use one". Instead it should just accept it and put into the timeline as a video layer.
5. Instead of having an "Video 2 / Audio 2" or X layer prepared, simply put an "Add a new Track" as title after the active/used layers with the following buttons: "New Video Track", "New Audio Track", "Open File" and a text "or drag and drop any supported file here" after. New Video/Audio Track simply adds an empty video or audio track with the (like it is now) "Open File" button and as a drop zone
6. Left of the ruler in the empty square below timeline add a title "Layers" and display a vertical thin bar at the right with some px gap to the timeline which can be dragged. Dragging it extends/shortens the layer titles area.
7. When another Aspect ratio/resolution gets clicked or dragged/changed, reposition the preview accordingly. Match the layers actual size at scale and relative positions from the CENTER at the new/changed aspect ratio or resolution - do not auto fill/adjust, because it messes layer positions up.
7.1 Additionally, when a direct aspect ratio/resolution gets clicked using buttons, recenter the whole preview frame in the new aspect ratio/resolution (again match relative size/scale and positions)
8. When a layer gets positioned at any position (circle) in render position, remember where it should stick to, also while scaling it it should stick to e.g. "right-top floating" if thats the selected circle. Keep the selected circle highlighted green until it gets dragged or another circle gets clicked.
9. Make the "Render Resolution: Width x Height" text only, no editboxes in the main window at the preview frame, thats what the crop render is for
10. In crop render the resolution numbers are shown twice. Remove the text and leave only the editboxes.
11. In layer cropping at render position, 100% should match its original resolution, not the "Crop Render" one. With scale it can be scaled up if needed.
12. Increase "Scale" from 1% to 1000%. make its slider logarithmic

V2.9 Update:
1. One layer should be able to hold multiple multiple tracks, Video and Audio. For example if there are 2 video tracks and i click to drag on video 2 but move the mouse upwards to video 1, show a green box like "drag and drop" area on video 1 layer in the length of the track from video 2 (let it open-end if it goes beyond current timeline scale to the right). Take into consideration where the initial click happened on the track in video 2 (timeline-wise) so it goes into the video 1 at the same distance from track-start to mouse click relative position in video 1.
2. Tracks on the same layer should be able to overlap. Now that fade-in/out is possible, this can be handeled by a transition (actually planned for v3, but it fits here) having the left track on the timeline fading out and the right track fading in where they overlap.
3. Cutting/splitting a track into sections on a single layer: Pressing "S" will split the current selected track into 2 with the cut happening at the "current position" slider's position.

V2.9.1:
1. Make empty layers (rows) right-clickable to show the menu, but only "paste" is enabled if comething is in the clipboard.
2. Let groups be allowed to stay on different layers. e.g. If i open/drag a file into video 2 which also has audio, Audio 2 gets auto-created which is good, but if i then drag the video track of the group from video 2 into video 1 the sound should not follow into Audio 1 but stay on Audio 2.
3. When a track gets deleted and the layer is empty now, do not auto-delete it.
4. Let the end/start of tracks on the same layer snap together perfectly if they are only a few pixel apart when dragged
5. When Tracks overlap one should fade out while the other fades in "transition" or isnt that (easily) possible? If i have 2 video layers one can fade out and the other can fade in at the same time, so it should also be doable if tracks overlap in a single layer, no?
6. When dragging a fade in/out slider, make it snap to the start/end of tracks in other layers if its only a few pixel away

Changes for 2.9 and 2.9.1:
1. Same as for fade in/out, while trimming/extending a track make it snap to fade in/out and start/end of other layers tracks.
2. Let fade sliders also snap to other layers tracks fade sliders
3. When fade or trim sliders snap by the few pixels, highlight the current dragged fade/trim slider and the one of the track it snapped to in green until it gets moved further or let go
4. When moving tracks across the timeline, let it snap to other layers tracks start/end and fade in/out sliders