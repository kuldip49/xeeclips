import {AppShell} from '@/components/app-shell';
import {ClippersWorkspace} from '@/components/clippers/workspace';
export function generateStaticParams(){return[{id:'_'}];}
export default function Page(){return <AppShell><ClippersWorkspace campaignRoute/></AppShell>;}
