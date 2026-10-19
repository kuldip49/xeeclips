'use client';
import {useEffect,useState,type ReactNode} from 'react';
import {AppShell} from '@/components/app-shell';
import {ClippersWorkspace} from './workspace';

/** Asset-only hosting serves index.html for a campaign ID that is not a build-time file. */
export function StaticEntry({children}:{children:ReactNode}){
 const [path,setPath]=useState<string|null>(null);
 useEffect(()=>{setPath(window.location.pathname);},[]);
 if(path===null)return <p role='status' className='p-8 text-sm'>Opening workspace…</p>;
 if(/^\/clippers\/campaigns\/(?!new\/?$)[^/]+\/?$/.test(path))return <AppShell navigationPath={path}><ClippersWorkspace campaignRoute/></AppShell>;
 if(path==='/'||path==='/index.html')return children;
 return <AppShell><div className='grid gap-4 py-12'><h1 className='text-2xl font-semibold'>Page not found</h1><a href='/clippers' className='text-primary-soft underline'>Open Clipper Workspace</a></div></AppShell>;
}
