"""Measure alignment in production pixels; no preview-pixel tolerance inflation.
Usage: python SCRIPT PREVIEW_DIR EXPORT_DIR OUTPUT_JSON
For the 'before' reproduction, EXPORT_DIR can be the previous evidence folder.
"""
import io,json,sys,subprocess
from pathlib import Path
import numpy as np
from PIL import Image,ImageFilter,ImageChops
root=Path(__file__).resolve().parents[3]
ffmpeg=root/'.cache/ffmpeg-benchmark/ffmpeg-9.0.2-essentials_build/bin/ffmpeg.exe'
preview,export,out=map(Path,sys.argv[1:])
results=[]
for row in json.loads((preview/'preview-results.json').read_text()):
    name,view,t=row['name'],row['view'],row['t']
    file=export/f'{name}.mp4'
    if not file.exists(): file=export/'source19-editor-final.mp4'
    data=subprocess.run([str(ffmpeg),'-v','error','-ss',str(t),'-i',str(file),'-frames:v','1','-f','image2pipe','-vcodec','png','-'],capture_output=True,check=True).stdout
    a=Image.open(preview/f'{name}-{view}-t{t}.png').convert('RGB').resize((1080,1920),Image.Resampling.LANCZOS)
    b=Image.open(io.BytesIO(data)).convert('RGB')
    # Match image gradients; grading and codecs can differ in luminance without
    # moving edges. Blur also suppresses mobile resampling antialiasing noise.
    def edges(im):
        v=np.asarray(im.convert('L').filter(ImageFilter.GaussianBlur(1.8))).astype(float)
        return np.stack((np.gradient(v,axis=0),np.gradient(v,axis=1)),axis=-1)
    A,B=edges(a),edges(b)
    shifts=[]
    for x0,x1,y0,y1 in [(40,520,690,900),(560,1040,690,900),(40,520,920,1180),(560,1040,920,1180)]:
        ar=A[y0:y1:2,x0:x1:2];best=(float('inf'),0,0)
        for dy in range(-10,11):
            for dx in range(-10,11):
                br=B[y0+dy:y1+dy:2,x0+dx:x1+dx:2]
                score=float(np.mean((ar-br)**2))
                if score<best[0]:best=(score,dx,dy)
        shifts.append({'dx':best[1],'dy':best[2],'edgeMse':round(best[0],5)})
    # Blank matte quadrants have no location information and cannot certify
    # an offset: report them separately, use textured quadrants for alignment.
    textured=[s for s,(x0,x1,y0,y1) in zip(shifts,[(40,520,690,900),(560,1040,690,900),(40,520,920,1180),(560,1040,920,1180)]) if float(np.var(A[y0:y1,x0:x1]))>.1]
    delta=max([max(abs(s['dx']),abs(s['dy'])) for s in textured],default=0)
    r={**row,'quadrants':shifts,'texturedQuadrants':len(textured),'maxPositionDelta1080Px':delta,'pass':bool(textured) and delta<=2}
    results.append(r)
    if view=='desktop':
        pair=Image.new('RGB',(2160,1920),'white');pair.paste(a,(0,0));pair.paste(b,(1080,0));pair.save(preview/f'{name}-t{t}-pair.png')
        Image.blend(a,b,.5).save(preview/f'{name}-t{t}-overlay.png')
        ImageChops.difference(a,b).save(preview/f'{name}-t{t}-difference.png')
    print(name,view,t,'max position delta',delta,'PASS' if r['pass'] else 'FAIL',[(s['dx'],s['dy']) for s in textured],flush=True)
out.write_text(json.dumps({'units':'1080x1920 production pixels','thresholdPx':2,'frames':results,'allPass':all(r['pass'] for r in results)},indent=2))
