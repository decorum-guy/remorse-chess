"""Original deterministic Forpost sound bank. Python + NumPy + SciPy, no samples from other games."""
from pathlib import Path
import numpy as np
from scipy import signal
import wave,hashlib,json,math
ROOT=Path(__file__).resolve().parents[1];OUT=ROOT/'public/assets/forpost/audio';OUT.mkdir(parents=True,exist_ok=True)
RATE=44100

def noise(n,rng,lo=60,hi=16000):
 x=rng.normal(0,1,n)
 return signal.sosfilt(signal.butter(3,[lo,hi],btype='bandpass',fs=RATE,output='sos'),x)
def tone(t,f,decay=8):return np.sin(2*np.pi*f*t)*np.exp(-decay*t)
def strike(t,rng,body=150,crack=2000,tail=18):
 return .54*tone(t,body,tail)+.22*tone(t,body*2.38,tail*1.4)+.58*noise(len(t),rng,crack,15000)*np.exp(-55*t)+.12*noise(len(t),rng,300,3500)*np.exp(-12*t)
def chime(t,notes,rate=8):
 y=np.zeros_like(t)
 for i,n in enumerate(notes):
  tt=np.maximum(0,t-i*.075);y+=(t>=i*.075)*tone(tt,n,rate)*.4
 return y
spec=[
 ('carbine',.26,'combat',1.0,'Dry short mechanical report with restrained low body'),
 ('shotgun',.64,'combat',1.0,'Wider low report, metallic cycling tail'),
 ('rifle',.55,'combat',1.0,'Tight crack with resonant steel tail'),
 ('drone-fire',.22,'combat',.72,'Small servo gun report'),
 ('turret-fire',.28,'combat',.8,'Heavy mounted gun report'),
 ('battery-fire',.75,'combat',.95,'Charged metallic rail impulse'),
 ('empty',.15,'ui',.65,'Dry magazine click'),
 ('reload-start',.29,'combat',.66,'Release catch and magazine movement'),
 ('reload-end',.23,'combat',.7,'Magazine lock and short bolt return'),
 ('barrier',.7,'combat',.85,'Metal deployment impact and stabilizing field'),
 ('smoke',1.0,'combat',.7,'Canister release and falling filtered pressure'),
 ('repair',1.0,'combat',.65,'Pulsed maintenance arc with mechanical hum'),
 ('order',.22,'ui',.75,'Brief two-note confirmed order'),
 ('error',.32,'ui',.7,'Descending restrained denied action'),
 ('menu',.13,'ui',.55,'Soft mechanical switch'),
 ('build-start',.48,'combat',.72,'Ground anchor and drive engagement'),
 ('build-complete',.72,'combat',.8,'Locking mechanism and rising ready tone'),
 ('destroy',.9,'combat',.9,'Low metal collapse with uneven debris'),
 ('power-lost',.75,'combat',.75,'Motor winding down'),
 ('transport-spawn',.95,'combat',.8,'Diesel-electric start and clearance signal'),
 ('unload-start',.65,'combat',.72,'Coupling click and steady charging indication'),
 ('unload-interrupted',.48,'combat',.8,'Short interrupted coupling warning'),
 ('unload-success',1.05,'combat',.85,'Power transfer lock and bright three-step arrival'),
 ('station-captured',.72,'combat',.8,'Relay handshake and rising status pair'),
 ('respawn',.78,'combat',.72,'Equipment engagement and ready tone'),
 ('overtime',1.25,'combat',.9,'Three spaced low industrial warning notes'),
 ('operation-end',1.65,'combat',.95,'Resolved four-note operation cadence'),
 ('hit',.16,'combat',.58,'Short armour contact'),
 ('engine-loop',2.0,'combat',.4,'Seamless electric drivetrain loop'),
]
manifest=[]
for name,duration,group,gain,desc in spec:
 n=round(duration*RATE);t=np.arange(n)/RATE;rng=np.random.default_rng(int(hashlib.sha256(name.encode()).hexdigest()[:8],16))
 if name in ['carbine','drone-fire','turret-fire']:
  y=strike(t,rng,{'carbine':145,'drone-fire':220,'turret-fire':105}[name],2400,24)
 elif name=='shotgun':
  y=strike(t,rng,80,1100,12)+.32*noise(n,rng,100,8000)*np.exp(-10*t)
  k=t-.29;y+=(k>0)*.2*np.sin(2*np.pi*560*k)*np.exp(-32*np.maximum(k,0))
 elif name=='rifle':y=strike(t,rng,118,3500,17)+.1*tone(t,1260,13)
 elif name=='battery-fire':y=strike(t,rng,62,500,10)+.3*np.sin(2*np.pi*(900*t-520*t*t))*np.exp(-7*t)
 elif name=='empty':y=.6*noise(n,rng,2200,10000)*np.exp(-85*t)+.3*tone(t,730,80)
 elif name=='reload-start':y=.4*noise(n,rng,900,6000)*np.exp(-30*t)+.3*noise(n,rng,600,3200)*np.exp(-45*np.abs(t-.14))+.3*tone(t,420,30)
 elif name=='reload-end':y=.6*noise(n,rng,700,6000)*np.exp(-45*t)+.35*tone(t,290,24)
 elif name=='barrier':y=strike(t,rng,110,800,14)+.24*np.sin(2*np.pi*330*t)*np.exp(-4*t)
 elif name=='smoke':y=noise(n,rng,500,6000)*(.08+np.minimum(t/.06,1))*np.exp(-3*t)+.2*tone(t,460,35)
 elif name=='repair':y=.2*np.sin(2*np.pi*105*t)+.2*np.sin(2*np.pi*315*t)+.12*noise(n,rng,1200,4200)*(.65+.35*np.sin(2*np.pi*14*t));y*=np.minimum(t/.06,1)*np.minimum((duration-t)/.12,1)
 elif name=='order':y=chime(t,[610,815],25)+.1*noise(n,rng,800,3500)*np.exp(-35*t)
 elif name=='error':y=chime(t,[340,255],16)
 elif name=='menu':y=.35*tone(t,550,40)+.12*noise(n,rng,1000,3000)*np.exp(-70*t)
 elif name=='build-start':y=strike(t,rng,105,800,18)+.18*np.sin(2*np.pi*(160*t+80*t*t))*np.exp(-9*t)
 elif name=='build-complete':y=.5*strike(t,rng,220,1400,24)+chime(t,[420,630,840],10)
 elif name=='destroy':
  y=.55*noise(n,rng,50,4500)*np.exp(-5*t)+.6*tone(t,60,8)
  for dt,f in [(.12,230),(.29,370),(.48,510)]:
   q=np.maximum(t-dt,0);y+=(t>=dt)*.22*tone(q,f,22)
 elif name=='power-lost':y=.5*np.sin(2*np.pi*(260*t-145*t*t))*np.exp(-3*t)+.1*noise(n,rng,300,2400)*np.exp(-6*t)
 elif name=='transport-spawn':y=.3*np.sin(2*np.pi*(50*t+32*t*t))*np.exp(-2*t)+.1*noise(n,rng,90,1400)*np.exp(-3*t)+chime(t,[390,520],9)
 elif name=='unload-start':y=.35*strike(t,rng,215,1000,25)+chime(t,[330,440],7)
 elif name=='unload-interrupted':y=chime(t,[550,370,280],12)
 elif name=='unload-success':y=chime(t,[440,660,880,1100],5)+.1*noise(n,rng,600,3500)*np.exp(-12*t)
 elif name=='station-captured':y=chime(t,[360,540,720],7)
 elif name=='respawn':y=chime(t,[300,450,600],6)+.08*noise(n,rng,250,1800)*np.exp(-4*t)
 elif name=='overtime':
  y=np.zeros(n)
  for dt in [0,.36,.72]:
   q=np.maximum(0,t-dt);y+=(t>=dt)*(.3*tone(q,220,9)+.15*tone(q,330,11))
 elif name=='operation-end':y=chime(t,[220,330,440,660],3)+.2*tone(t,110,2)
 elif name=='hit':y=.4*noise(n,rng,1100,8000)*np.exp(-40*t)+.5*tone(t,560,25)
 elif name=='engine-loop':y=.2*np.sin(2*np.pi*70*t)+.07*np.sin(2*np.pi*140*t)+.04*np.sin(2*np.pi*350*t)
 y-=y.mean()
 if name!='engine-loop':
  fade=int(.008*RATE);y[:fade]*=np.linspace(0,1,fade);y[-fade:]*=np.linspace(1,0,fade)
 peak=np.max(np.abs(y));y=y/max(peak,1e-6)*.79
 pcm=np.clip(np.round(y*32767),-32768,32767).astype('<i2');path=OUT/(name+'.wav')
 with wave.open(str(path),'wb') as w:w.setnchannels(1);w.setsampwidth(2);w.setframerate(RATE);w.writeframes(pcm.tobytes())
 data=path.read_bytes();manifest.append({'assetId':name,'path':'audio/'+path.name,'duration':duration,'sampleRate':RATE,'channels':1,'format':'PCM16','peak':float(np.max(np.abs(pcm)))/32768,'rms':float(np.sqrt(np.mean((pcm.astype(float)/32768)**2))),'gain':gain,'group':group,'priority':3 if name in ['operation-end','overtime','unload-success'] else 1,'description':desc,'sha256':hashlib.sha256(data).hexdigest(),'bytes':len(data),'authorship':'Original procedural synthesis for Iva Games','listening':'not yet performed'})
(ROOT/'art/audio-manifest.json').write_text(json.dumps(manifest,indent=2)+'\n');print(json.dumps({'sounds':len(manifest),'bytes':sum(x['bytes'] for x in manifest),'maxPeak':max(x['peak'] for x in manifest)},indent=2))
