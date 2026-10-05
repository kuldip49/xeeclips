export default function EditModeLoading() {
  return <div className='flex h-[100dvh] flex-col bg-[#070a12]' aria-busy='true' aria-label='Loading editor'>
    <div className='pt-safe border-b border-white/10 bg-[#0d111c]'><div className='flex h-12 items-center gap-3 px-3'>
      <div className='skeleton h-8 w-8 rounded-full' /><div className='skeleton h-4 w-40' /><div className='skeleton ml-auto h-8 w-20 rounded-xl' /></div></div>
    <div className='flex min-h-0 flex-1 items-center justify-center p-3'>
      <div className='skeleton aspect-[9/16] h-full max-h-[70vh] rounded-xl' /></div>
    <div className='skeleton mx-3 mb-3 h-[28dvh] max-h-[260px] rounded-xl md:h-[38vh] md:max-h-[440px]' />
    <span className='sr-only'>Loading editor…</span>
  </div>;
}
