'use client';

import { useEffect } from 'react';
import { usePathname, useRouter } from 'next/navigation';

/** `/projects/<id>` -> `/?session=<id>`, read from the URL so the static shell works for any id. */
export function ProjectSessionRedirect() {
  const pathname = usePathname();
  const router = useRouter();
  useEffect(() => {
    const id = pathname?.split('/').filter(Boolean)[1];
    router.replace(id && id !== '_' ? `/?session=${encodeURIComponent(decodeURIComponent(id))}` : '/');
  }, [pathname, router]);
  return null;
}
