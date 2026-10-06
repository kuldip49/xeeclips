import { ProjectSessionRedirect } from '@/components/project-session-redirect';

/** Old project links open their creation session. One prerendered shell serves every id. */
export function generateStaticParams() {
  return [{ id: '_' }];
}

export default function ProjectRedirect() {
  return <ProjectSessionRedirect />;
}
