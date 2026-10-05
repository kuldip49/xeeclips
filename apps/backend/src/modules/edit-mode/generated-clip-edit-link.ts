export type GeneratedClipEditProjectRef = { id: string } | null | undefined;

export const editProjectRoute = (editProjectId: string) =>
  `/edit-mode/${encodeURIComponent(editProjectId)}`;

export const generatedClipEditLink = (editProject: GeneratedClipEditProjectRef) => ({
  editProjectId: editProject?.id ?? null,
  isEditable: true,
  editUrl: editProject ? editProjectRoute(editProject.id) : null
});
