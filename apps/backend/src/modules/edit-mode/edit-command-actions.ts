// Canonical manual-editor action names. Shared by HTTP validation and MCP discovery.
export const PHASE3_ACTIONS = [
    'ADD_IMAGE', 'ADD_LOGO', 'ADD_TEXT', 'ADD_AUDIO', 'MOVE_ELEMENT', 'RESIZE_ELEMENT',
    'SET_ELEMENT_TIMING', 'SET_ELEMENT_OPACITY', 'SET_ELEMENT_Z_INDEX', 'UPDATE_TEXT',
    'SET_AUDIO_VOLUME', 'SET_AUDIO_MUTED', 'SET_AUDIO_FADE', 'DUPLICATE_ELEMENT', 'REMOVE_ELEMENT',
    // Manual transform. Crop, rotation and flip apply to the VIDEO track and to
    // IMAGE/LOGO overlays; scale, position and speed are VIDEO-only. They are
    // ordinary typed commands, so they inherit validation, history and undo, and
    // an assistant bundle reaches them by exactly the same path the editor does.
    'SET_VIDEO_CROP', 'SET_VIDEO_ROTATION', 'SET_VIDEO_FLIP', 'SET_VIDEO_SCALE',
    'SET_VIDEO_POSITION', 'SET_SPEED',
    // Workstream C: professional text. Each property is its own typed, validated,
    // undoable command rather than one JSON patch, so an assistant turn and the
    // inspector reach exactly the same code with exactly the same bounds.
    'SET_TEXT_CONTENT', 'SET_TEXT_FONT', 'SET_TEXT_SIZE', 'SET_TEXT_WEIGHT', 'SET_TEXT_COLOR',
    'SET_TEXT_ALIGNMENT', 'SET_TEXT_STROKE', 'SET_TEXT_SHADOW', 'SET_TEXT_BACKGROUND',
    'SET_TEXT_SPACING', 'SET_TEXT_STYLE_PRESET', 'SET_TEXT_CASE', 'SET_TEXT_RUNS',
    // Workstream C: captions. Generation, wording, split, merge and style are all
    // canonical element mutations on the same SUBTITLE elements the renderer reads.
    'GENERATE_CAPTIONS', 'REMOVE_CAPTIONS', 'SET_CAPTIONS_VISIBLE', 'SET_CAPTION_TEXT',
    'SPLIT_CAPTION', 'MERGE_CAPTION', 'SET_CAPTION_STYLE', 'SET_CAPTION_ACTIVE_WORD',
    'APPLY_CAPTION_STYLE_TO_ALL',
    // Workstream D: professional colour. One typed command per control rather
    // than a generic SET_VIDEO_COLOR_PROPERTIES patch, so every change is
    // independently validated, independently undoable, and reachable by name from
    // a later assistant turn ("make it warmer") without a JSON schema in between.
    'SET_VIDEO_EXPOSURE', 'SET_VIDEO_BRIGHTNESS', 'SET_VIDEO_CONTRAST', 'SET_VIDEO_HIGHLIGHTS',
    'SET_VIDEO_SHADOWS', 'SET_VIDEO_SATURATION', 'SET_VIDEO_TEMPERATURE', 'SET_VIDEO_TINT',
    'SET_VIDEO_SHARPNESS', 'SET_VIDEO_FADE', 'SET_VIDEO_VIGNETTE',
    'RESET_VIDEO_ADJUSTMENTS', 'APPLY_COLOR_FILTER', 'PASTE_VIDEO_ADJUSTMENTS',
    // Workstream D: audio. The source video's own level, a music clip's source
    // trim, and speech ducking.
    'SET_SOURCE_AUDIO_VOLUME', 'SET_SOURCE_AUDIO_MUTED', 'SET_AUDIO_TRIM', 'SET_AUDIO_DUCKING',
    // Workstream E: the two pieces of timeline track state that have to survive a
    // reload and reach the renderer. Both already existed as stored properties
    // (`hidden` was honoured by the render plan, `locked` by the preview) with no
    // command able to set them; these close that gap rather than inventing state.
    'SET_ELEMENT_VISIBLE', 'SET_ELEMENT_LOCKED',
    // Workstream G: a zoom is an editable EFFECT element, so "make this zoom
    // deeper" changes that one event rather than re-planning every zoom.
    'ADD_ZOOM', 'SET_ZOOM_SCALE', 'REMOVE_ZOOM',
    // Step 5: canonical scope primitives. Whole-project framing and reframe
    // policy, relative zoom strength, and explicit caption regeneration (the only
    // command besides SET_CAPTION_TEXT allowed to rewrite caption wording).
    'SET_VIDEO_FRAMING', 'SET_REFRAME_POLICY', 'ADJUST_ZOOM_STRENGTH', 'REGENERATE_CAPTIONS',
    // Step 10: what shows behind a fitted (letterboxed) frame.
    'SET_FIT_BACKGROUND'
] as const;
