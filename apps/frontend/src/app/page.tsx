import CreatePage from './create/page';
import {StaticEntry} from '@/components/clippers/static-entry';

export const metadata = { title: 'Create clips' };
export default function Page(){return <StaticEntry><CreatePage/></StaticEntry>;}
