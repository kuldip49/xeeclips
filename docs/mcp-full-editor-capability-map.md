# Full canonical editor capability map

Audit baseline: c4eee02 / deployed MCP 1.2.1. The human surface was inspected in the inspector/text/transform/timeline/audio/captions/filter/template panels and their API/domain handlers. The rows below name real canonical commands; none are inferred from UI animations.

| Human editor action | Canonical service / command | EditProject representation | MCP baseline → implemented exposure |
|---|---|---|---|
| Add Image | `EditModeService.applyAssistantBundle / ADD_IMAGE` | typed EditElement properties/timing/track or canonical timeline settings | partial/existing → `xeeclip_apply_edit_commands` |
| Add Logo | `EditModeService.applyAssistantBundle / ADD_LOGO` | typed EditElement properties/timing/track or canonical timeline settings | partial/existing → `xeeclip_apply_edit_commands` |
| Add Text | `EditModeService.applyAssistantBundle / ADD_TEXT` | typed EditElement properties/timing/track or canonical timeline settings | missing → `xeeclip_apply_edit_commands` |
| Add Audio | `EditModeService.applyAssistantBundle / ADD_AUDIO` | typed EditElement properties/timing/track or canonical timeline settings | partial/existing → `xeeclip_apply_edit_commands` |
| Move Element | `EditModeService.applyAssistantBundle / MOVE_ELEMENT` | typed EditElement properties/timing/track or canonical timeline settings | partial/existing → `xeeclip_apply_edit_commands` |
| Resize Element | `EditModeService.applyAssistantBundle / RESIZE_ELEMENT` | typed EditElement properties/timing/track or canonical timeline settings | partial/existing → `xeeclip_apply_edit_commands` |
| Set Element Timing | `EditModeService.applyAssistantBundle / SET_ELEMENT_TIMING` | typed EditElement properties/timing/track or canonical timeline settings | partial/existing → `xeeclip_apply_edit_commands` |
| Set Element Opacity | `EditModeService.applyAssistantBundle / SET_ELEMENT_OPACITY` | typed EditElement properties/timing/track or canonical timeline settings | partial/existing → `xeeclip_apply_edit_commands` |
| Set Element Z Index | `EditModeService.applyAssistantBundle / SET_ELEMENT_Z_INDEX` | typed EditElement properties/timing/track or canonical timeline settings | missing → `xeeclip_apply_edit_commands` |
| Update Text | `EditModeService.applyAssistantBundle / UPDATE_TEXT` | typed EditElement properties/timing/track or canonical timeline settings | missing → `xeeclip_apply_edit_commands` |
| Set Audio Volume | `EditModeService.applyAssistantBundle / SET_AUDIO_VOLUME` | typed EditElement properties/timing/track or canonical timeline settings | partial/existing → `xeeclip_apply_edit_commands` |
| Set Audio Muted | `EditModeService.applyAssistantBundle / SET_AUDIO_MUTED` | typed EditElement properties/timing/track or canonical timeline settings | missing → `xeeclip_apply_edit_commands` |
| Set Audio Fade | `EditModeService.applyAssistantBundle / SET_AUDIO_FADE` | typed EditElement properties/timing/track or canonical timeline settings | missing → `xeeclip_apply_edit_commands` |
| Duplicate Element | `EditModeService.applyAssistantBundle / DUPLICATE_ELEMENT` | typed EditElement properties/timing/track or canonical timeline settings | missing → `xeeclip_apply_edit_commands` |
| Remove Element | `EditModeService.applyAssistantBundle / REMOVE_ELEMENT` | typed EditElement properties/timing/track or canonical timeline settings | partial/existing → `xeeclip_apply_edit_commands` |
| Set Video Crop | `EditModeService.applyAssistantBundle / SET_VIDEO_CROP` | typed EditElement properties/timing/track or canonical timeline settings | partial/existing → `xeeclip_apply_edit_commands` |
| Set Video Rotation | `EditModeService.applyAssistantBundle / SET_VIDEO_ROTATION` | typed EditElement properties/timing/track or canonical timeline settings | missing → `xeeclip_apply_edit_commands` |
| Set Video Flip | `EditModeService.applyAssistantBundle / SET_VIDEO_FLIP` | typed EditElement properties/timing/track or canonical timeline settings | missing → `xeeclip_apply_edit_commands` |
| Set Video Scale | `EditModeService.applyAssistantBundle / SET_VIDEO_SCALE` | typed EditElement properties/timing/track or canonical timeline settings | partial/existing → `xeeclip_apply_edit_commands` |
| Set Video Position | `EditModeService.applyAssistantBundle / SET_VIDEO_POSITION` | typed EditElement properties/timing/track or canonical timeline settings | partial/existing → `xeeclip_apply_edit_commands` |
| Set Speed | `EditModeService.applyAssistantBundle / SET_SPEED` | typed EditElement properties/timing/track or canonical timeline settings | missing → `xeeclip_apply_edit_commands` |
| Set Text Content | `EditModeService.applyAssistantBundle / SET_TEXT_CONTENT` | typed EditElement properties/timing/track or canonical timeline settings | partial/existing → `xeeclip_apply_edit_commands` |
| Set Text Font | `EditModeService.applyAssistantBundle / SET_TEXT_FONT` | typed EditElement properties/timing/track or canonical timeline settings | missing → `xeeclip_apply_edit_commands` |
| Set Text Size | `EditModeService.applyAssistantBundle / SET_TEXT_SIZE` | typed EditElement properties/timing/track or canonical timeline settings | partial/existing → `xeeclip_apply_edit_commands` |
| Set Text Weight | `EditModeService.applyAssistantBundle / SET_TEXT_WEIGHT` | typed EditElement properties/timing/track or canonical timeline settings | missing → `xeeclip_apply_edit_commands` |
| Set Text Color | `EditModeService.applyAssistantBundle / SET_TEXT_COLOR` | typed EditElement properties/timing/track or canonical timeline settings | partial/existing → `xeeclip_apply_edit_commands` |
| Set Text Alignment | `EditModeService.applyAssistantBundle / SET_TEXT_ALIGNMENT` | typed EditElement properties/timing/track or canonical timeline settings | partial/existing → `xeeclip_apply_edit_commands` |
| Set Text Stroke | `EditModeService.applyAssistantBundle / SET_TEXT_STROKE` | typed EditElement properties/timing/track or canonical timeline settings | partial/existing → `xeeclip_apply_edit_commands` |
| Set Text Shadow | `EditModeService.applyAssistantBundle / SET_TEXT_SHADOW` | typed EditElement properties/timing/track or canonical timeline settings | partial/existing → `xeeclip_apply_edit_commands` |
| Set Text Background | `EditModeService.applyAssistantBundle / SET_TEXT_BACKGROUND` | typed EditElement properties/timing/track or canonical timeline settings | partial/existing → `xeeclip_apply_edit_commands` |
| Set Text Spacing | `EditModeService.applyAssistantBundle / SET_TEXT_SPACING` | typed EditElement properties/timing/track or canonical timeline settings | missing → `xeeclip_apply_edit_commands` |
| Set Text Style Preset | `EditModeService.applyAssistantBundle / SET_TEXT_STYLE_PRESET` | typed EditElement properties/timing/track or canonical timeline settings | missing → `xeeclip_apply_edit_commands` |
| Set Text Case | `EditModeService.applyAssistantBundle / SET_TEXT_CASE` | typed EditElement properties/timing/track or canonical timeline settings | missing → `xeeclip_apply_edit_commands` |
| Set Text Runs | `EditModeService.applyAssistantBundle / SET_TEXT_RUNS` | typed EditElement properties/timing/track or canonical timeline settings | missing → `xeeclip_apply_edit_commands` |
| Generate Captions | `EditModeService.applyAssistantBundle / GENERATE_CAPTIONS` | typed EditElement properties/timing/track or canonical timeline settings | missing → `xeeclip_apply_edit_commands` |
| Remove Captions | `EditModeService.applyAssistantBundle / REMOVE_CAPTIONS` | typed EditElement properties/timing/track or canonical timeline settings | missing → `xeeclip_apply_edit_commands` |
| Set Captions Visible | `EditModeService.applyAssistantBundle / SET_CAPTIONS_VISIBLE` | typed EditElement properties/timing/track or canonical timeline settings | missing → `xeeclip_apply_edit_commands` |
| Set Caption Text | `EditModeService.applyAssistantBundle / SET_CAPTION_TEXT` | typed EditElement properties/timing/track or canonical timeline settings | partial/existing → `xeeclip_apply_edit_commands` |
| Split Caption | `EditModeService.applyAssistantBundle / SPLIT_CAPTION` | typed EditElement properties/timing/track or canonical timeline settings | missing → `xeeclip_apply_edit_commands` |
| Merge Caption | `EditModeService.applyAssistantBundle / MERGE_CAPTION` | typed EditElement properties/timing/track or canonical timeline settings | missing → `xeeclip_apply_edit_commands` |
| Set Caption Style | `EditModeService.applyAssistantBundle / SET_CAPTION_STYLE` | typed EditElement properties/timing/track or canonical timeline settings | partial/existing → `xeeclip_apply_edit_commands` |
| Set Caption Active Word | `EditModeService.applyAssistantBundle / SET_CAPTION_ACTIVE_WORD` | typed EditElement properties/timing/track or canonical timeline settings | missing → `xeeclip_apply_edit_commands` |
| Apply Caption Style To All | `EditModeService.applyAssistantBundle / APPLY_CAPTION_STYLE_TO_ALL` | typed EditElement properties/timing/track or canonical timeline settings | missing → `xeeclip_apply_edit_commands` |
| Set Video Exposure | `EditModeService.applyAssistantBundle / SET_VIDEO_EXPOSURE` | typed EditElement properties/timing/track or canonical timeline settings | missing → `xeeclip_apply_edit_commands` |
| Set Video Brightness | `EditModeService.applyAssistantBundle / SET_VIDEO_BRIGHTNESS` | typed EditElement properties/timing/track or canonical timeline settings | missing → `xeeclip_apply_edit_commands` |
| Set Video Contrast | `EditModeService.applyAssistantBundle / SET_VIDEO_CONTRAST` | typed EditElement properties/timing/track or canonical timeline settings | missing → `xeeclip_apply_edit_commands` |
| Set Video Highlights | `EditModeService.applyAssistantBundle / SET_VIDEO_HIGHLIGHTS` | typed EditElement properties/timing/track or canonical timeline settings | missing → `xeeclip_apply_edit_commands` |
| Set Video Shadows | `EditModeService.applyAssistantBundle / SET_VIDEO_SHADOWS` | typed EditElement properties/timing/track or canonical timeline settings | missing → `xeeclip_apply_edit_commands` |
| Set Video Saturation | `EditModeService.applyAssistantBundle / SET_VIDEO_SATURATION` | typed EditElement properties/timing/track or canonical timeline settings | missing → `xeeclip_apply_edit_commands` |
| Set Video Temperature | `EditModeService.applyAssistantBundle / SET_VIDEO_TEMPERATURE` | typed EditElement properties/timing/track or canonical timeline settings | missing → `xeeclip_apply_edit_commands` |
| Set Video Tint | `EditModeService.applyAssistantBundle / SET_VIDEO_TINT` | typed EditElement properties/timing/track or canonical timeline settings | missing → `xeeclip_apply_edit_commands` |
| Set Video Sharpness | `EditModeService.applyAssistantBundle / SET_VIDEO_SHARPNESS` | typed EditElement properties/timing/track or canonical timeline settings | missing → `xeeclip_apply_edit_commands` |
| Set Video Fade | `EditModeService.applyAssistantBundle / SET_VIDEO_FADE` | typed EditElement properties/timing/track or canonical timeline settings | missing → `xeeclip_apply_edit_commands` |
| Set Video Vignette | `EditModeService.applyAssistantBundle / SET_VIDEO_VIGNETTE` | typed EditElement properties/timing/track or canonical timeline settings | missing → `xeeclip_apply_edit_commands` |
| Reset Video Adjustments | `EditModeService.applyAssistantBundle / RESET_VIDEO_ADJUSTMENTS` | typed EditElement properties/timing/track or canonical timeline settings | missing → `xeeclip_apply_edit_commands` |
| Apply Color Filter | `EditModeService.applyAssistantBundle / APPLY_COLOR_FILTER` | typed EditElement properties/timing/track or canonical timeline settings | partial/existing → `xeeclip_apply_edit_commands` |
| Paste Video Adjustments | `EditModeService.applyAssistantBundle / PASTE_VIDEO_ADJUSTMENTS` | typed EditElement properties/timing/track or canonical timeline settings | missing → `xeeclip_apply_edit_commands` |
| Set Source Audio Volume | `EditModeService.applyAssistantBundle / SET_SOURCE_AUDIO_VOLUME` | typed EditElement properties/timing/track or canonical timeline settings | partial/existing → `xeeclip_apply_edit_commands` |
| Set Source Audio Muted | `EditModeService.applyAssistantBundle / SET_SOURCE_AUDIO_MUTED` | typed EditElement properties/timing/track or canonical timeline settings | missing → `xeeclip_apply_edit_commands` |
| Set Audio Trim | `EditModeService.applyAssistantBundle / SET_AUDIO_TRIM` | typed EditElement properties/timing/track or canonical timeline settings | missing → `xeeclip_apply_edit_commands` |
| Set Audio Ducking | `EditModeService.applyAssistantBundle / SET_AUDIO_DUCKING` | typed EditElement properties/timing/track or canonical timeline settings | missing → `xeeclip_apply_edit_commands` |
| Set Element Visible | `EditModeService.applyAssistantBundle / SET_ELEMENT_VISIBLE` | typed EditElement properties/timing/track or canonical timeline settings | missing → `xeeclip_apply_edit_commands` |
| Set Element Locked | `EditModeService.applyAssistantBundle / SET_ELEMENT_LOCKED` | typed EditElement properties/timing/track or canonical timeline settings | missing → `xeeclip_apply_edit_commands` |
| Add Zoom | `EditModeService.applyAssistantBundle / ADD_ZOOM` | typed EditElement properties/timing/track or canonical timeline settings | missing → `xeeclip_apply_edit_commands` |
| Set Zoom Scale | `EditModeService.applyAssistantBundle / SET_ZOOM_SCALE` | typed EditElement properties/timing/track or canonical timeline settings | missing → `xeeclip_apply_edit_commands` |
| Remove Zoom | `EditModeService.applyAssistantBundle / REMOVE_ZOOM` | typed EditElement properties/timing/track or canonical timeline settings | missing → `xeeclip_apply_edit_commands` |
| Set Video Framing | `EditModeService.applyAssistantBundle / SET_VIDEO_FRAMING` | typed EditElement properties/timing/track or canonical timeline settings | missing → `xeeclip_apply_edit_commands` |
| Set Reframe Policy | `EditModeService.applyAssistantBundle / SET_REFRAME_POLICY` | typed EditElement properties/timing/track or canonical timeline settings | missing → `xeeclip_apply_edit_commands` |
| Adjust Zoom Strength | `EditModeService.applyAssistantBundle / ADJUST_ZOOM_STRENGTH` | typed EditElement properties/timing/track or canonical timeline settings | missing → `xeeclip_apply_edit_commands` |
| Regenerate Captions | `EditModeService.applyAssistantBundle / REGENERATE_CAPTIONS` | typed EditElement properties/timing/track or canonical timeline settings | missing → `xeeclip_apply_edit_commands` |
| Set Fit Background | `EditModeService.applyAssistantBundle / SET_FIT_BACKGROUND` | typed EditElement properties/timing/track or canonical timeline settings | missing → `xeeclip_apply_edit_commands` |
| Trim Element | `EditModeService.trimElement` | typed EditElement properties/timing/track or canonical timeline settings | missing → `xeeclip_apply_edit_commands` |
| Split Element | `EditModeService.applyAssistantBundle / SPLIT_ELEMENT` | typed EditElement properties/timing/track or canonical timeline settings | missing → `xeeclip_apply_edit_commands` |
| Delete Element | `EditModeService.applyAssistantBundle / DELETE_ELEMENT` | typed EditElement properties/timing/track or canonical timeline settings | missing → `xeeclip_apply_edit_commands` |
| Reorder Element | `EditModeService.applyAssistantBundle / REORDER_ELEMENT` | typed EditElement properties/timing/track or canonical timeline settings | missing → `xeeclip_apply_edit_commands` |
| Adjust Source Range | `EditModeService.adjustSourceRange` | typed EditElement properties/timing/track or canonical timeline settings | missing → `xeeclip_adjust_source_range` |
| Add Subtitle | `EditModeService.applyAssistantBundle / ADD_SUBTITLE` | typed EditElement properties/timing/track or canonical timeline settings | missing → `xeeclip_apply_edit_commands` |
| Apply Preset | `EditModePresetService.apply → applyPresetBundle` | settings + canonical style/element bundle | missing → `xeeclip_apply_editor_preset` |
| Apply Template | `EditTemplateService.apply → applyTemplateBundle` | settings + canonical style/element bundle | missing → `xeeclip_change_template` |
| Set Resolved Visual Layout | `EditModeService.applyAssistantBundle / SET_RESOLVED_VISUAL_LAYOUT` | settings + canonical style/element bundle | missing → `xeeclip_change_template (internal shared compiler only)` |
| Undo | `EditModeService.undo` | EditHistory before/after state, same stack | partial/existing → `xeeclip_undo` |
| Redo | `EditModeService.redo` | EditHistory before/after state, same stack | partial/existing → `xeeclip_redo` |
| Save | `McpAdapterService: revision-checked persisted state` | persisted project revision | partial/existing → `xeeclip_save_edit` |
| Reload | `EditModeService.get` | persisted project revision | partial/existing → `xeeclip_get_edit_project` |
| Export | `EditModeRenderService.startExport/progress` | canonical EXPORT asset / renderer | partial/existing → `xeeclip_export_clip / xeeclip_get_export` |
| Review | `MediaReviewService / MediaReviewEvidenceService` | human-approved rendered-media grant/evidence | partial/existing → `xeeclip_request_video_review / xeeclip_review_video` |

Source evidence: `edit-command-actions.ts`, `edit-mode.service.ts`, `edit-agent-tools.ts`, `edit-mode-text.ts`, `edit-mode-audio.ts`, `edit-mode-color.ts`, `edit-template.service.ts`, `creative-style-commands.ts`, `resolved-visual-layout.ts`, and frontend `components/edit-mode/` / `lib/edit-mode-*`.

Standalone video transitions and arbitrary CSS/keyframe animations are not supported canonical editor actions. Do not advertise them. Supported motion consists of real video speed/framing/zoom events and timed word highlights with actual word timings. File/source ingestion uses existing owned-source/asset APIs; raw filesystem paths, arbitrary remote overlay URLs, project/account deletion and renderer command lines are outside editing permission.

Implemented in MCP 1.3.0: 60 tools total, including one strict 76-action canonical batch contract. All 71 inspector actions, caption creation and four timeline operations are covered. Read the actual discriminated command schema with Inspector or `get_editor_capabilities`; unsupported scopes/targets retain the canonical editor validation. Raw settings, CSS, filesystem paths, renderer commands and database writes have no public contract.

Additional reads: `list_edit_elements` paginates every type; `get_edit_layout` exposes resolved regions; `preview_element_placement` checks timed conflicts; `check_edit_requirements` reports objective metadata evidence separately from rendered review. Caption groups carry explicit IDs and structural labels, never automatic visual-duplicate certainty. `remove_caption_group` deletes only the selected group.

StyleZero resolves the existing clean text/caption/full-frame components locally in the editor. It does not add a new generation template or change Create Clips defaults. StyleOne/Two use the existing generation style compiler. Existing source cuts/transforms, corrected copy/timing, audio, overlays and zoom events survive; template text size can decrease through the shared fit metric. Owned/builtin saved templates use the existing template service, with strict protected-edit rejection and atomic operation receipts.

Acceptance evidence and limitations are recorded in [the release report](mcp-full-editor-control.md). Existing renderer parity notes still apply (for example rounded ASS plates and exact font weight approximation); the upgrade does not introduce new renderer effects. Human source pixels, burned-in text and baked audio remain source content.
