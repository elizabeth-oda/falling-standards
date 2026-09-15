import { Euler, Quaternion, Vector3 } from 'three';
import type { Position } from './player-controller';
import { sweptPickup as segmentSphere } from './world-geometry';

export { segmentSphere };

export type Item = 'parachute' | 'bubbleWrap' | 'airCanister';
export const ITEM_NAMES: Record<Item,string> = {parachute:'Spare parachute',bubbleWrap:'Bubble wrap',airCanister:'Emergency air canister'};
export type ObstacleKind = 'balloon'|'fridge'|'satellite'|'sofa'|'duct'|'cone'|'extinguisher'|'barrier'|'crate'|'capsule';
export type Collider = {center:Position; size:Position; sphere?:number; penalty:number};
export type Obstacle = {id:number;kind:ObstacleKind;position:Position;rotation:Position;active:boolean;hitAt:number};
export const OBSTACLE_RULES: Record<ObstacleKind,{heft:string;flail:number;knockback:number;colliders:Collider[]}> = {
  cone:{heft:'traffic control',flail:0.35,knockback:2,colliders:[{center:[0,0,0],size:[3,3,3],penalty:0.75}]},
  extinguisher:{heft:'fire drill',flail:0.45,knockback:3,colliders:[{center:[0,0,0],size:[1.8,3.6,1.8],penalty:0.6}]},
  barrier:{heft:'safety barrier',flail:0.5,knockback:3,colliders:[{center:[0,0,0],size:[5,3,1.6],penalty:0.55}]},
  crate:{heft:'equipment cargo',flail:0.55,knockback:3,colliders:[{center:[0,0,0],size:[3.4,3.4,3.4],penalty:0.5}]},
  capsule:{heft:'reentry trainer',flail:0.6,knockback:3,colliders:[{center:[0,0,0],size:[4,4.4,4],penalty:0.45}]},
  duct:{heft:'pipe wall',flail:0.6,knockback:2,colliders:[
    {center:[-6.5,0,0],size:[1,24,14],penalty:0.5},{center:[6.5,0,0],size:[1,24,14],penalty:0.5},
    {center:[0,0,-6.5],size:[12,24,1],penalty:0.5},{center:[0,0,6.5],size:[12,24,1],penalty:0.5},
  ]},
  balloon:{heft:'light',flail:0.3,knockback:1,colliders:[{center:[0,1,0],size:[3,4,3],sphere:2,penalty:0.8}]},
  fridge:{heft:'heavy',flail:0.6,knockback:3,colliders:[{center:[0,0,0],size:[2,3.6,1.8],penalty:0.4}]},
  satellite:{heft:'heavy body / light panels',flail:0.6,knockback:2,colliders:[
    {center:[0,0,0],size:[2.4,2.4,2.4],penalty:0.4},
    {center:[-4,0,0],size:[5,0.3,3],penalty:0.75},
    {center:[4,0,0],size:[5,0.3,3],penalty:0.75},
  ]},
  sofa:{heft:'bouncy',flail:0.45,knockback:5,colliders:[{center:[0,0,0],size:[4.8,2,2.4],penalty:0.6}]},
};
// A seeded stream makes a run reproducible, while reset supplies a fresh seed.
export function seededRandom(seed:number){
  return ()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
}
export function obstacleKindsAtDepth(depth:number):readonly ObstacleKind[]{
  if(depth<1100)return ['satellite','capsule','crate'];
  if(depth<2200)return ['balloon','capsule','crate','barrier'];
  return ['fridge','sofa','cone','extinguisher','barrier','crate'];
}
export function makeCourse(random:()=>number=Math.random) {
  const ducts=makeDucts(random),junk:Obstacle[]=[];
  for(let row=0;row<48;row++){
    const depth=160+row*65+random()*24;
    const occupied:Position[]=[];
    for(let slot=0;slot<4;slot++){
      let x=0,z=0,clear=false;
      for(let attempt=0;attempt<40;attempt++){
        x=random()*60-30;z=random()*60-30;
        if(occupied.every(p=>Math.hypot(x-p[0],z-p[2])>12)){clear=true;break;}
      }
      if(!clear)continue;
      const position:Position=[x,-depth-random()*18,z];
      if(ducts.some(d=>Math.abs(position[1]-d.position[1])<28&&Math.hypot(x-d.position[0],z-d.position[2])<18))continue;
      occupied.push(position);
      const kinds=obstacleKindsAtDepth(-position[1]);
      junk.push({id:row*4+slot,kind:kinds[Math.floor(random()*kinds.length)],position,
        rotation:[random()*Math.PI*2,random()*Math.PI*2,random()*Math.PI*2],active:true,hitAt:-1});
    }
  }
  return [...junk,...ducts];
}
export function makeDucts(random:()=>number=Math.random):Obstacle[]{
  return [550,1550,2550].flatMap((base,course)=>{
    const depth=base+random()*240,x=random()*36-18,z=random()*36-18;
    const angle=random()*Math.PI*2,dx=Math.cos(angle)*3,dz=Math.sin(angle)*3;
    return Array.from({length:3},(_,section)=>({id:1000+course*3+section,kind:'duct' as const,
      position:[x+section*dx,-depth-section*24,z+section*dz] as Position,
      rotation:[0,0,0] as Position,active:true,hitAt:-1}));
  });
}
export function obstaclePose(obstacle:Obstacle,time:number) {
  if(obstacle.kind==='duct')return {position:obstacle.position,rotation:obstacle.rotation};
  const p:[number,number,number]=[...obstacle.position];
  if(obstacle.kind==='balloon') p[0]+=Math.sin(time*0.4+obstacle.id)*2;
  const rotation:Position=[obstacle.rotation[0]+(obstacle.kind==='fridge'?time*0.35:0),obstacle.rotation[1]+time*0.3,obstacle.rotation[2]];
  return {position:p,rotation};
}
// Transform the swept player segment into each authored collider's local space.
// The expanded box is a conservative sphere-vs-box approximation at corners.
export function obstacleHit(a:Position,b:Position,obstacle:Obstacle,time:number):number|null {
  const pose=obstaclePose(obstacle,time);
  const inverse=new Quaternion().setFromEuler(new Euler(...pose.rotation)).invert();
  const local=(p:Position)=>new Vector3(...p).sub(new Vector3(...pose.position)).applyQuaternion(inverse);
  const start=local(a),end=local(b);
  for(const collider of OBSTACLE_RULES[obstacle.kind].colliders) {
    if(collider.sphere) {
      if(segmentSphere(start.toArray() as Position,end.toArray() as Position,collider.center,collider.sphere+0.65)) return collider.penalty;
      continue;
    }
    let near=0,far=1;
    for(let axis=0;axis<3;axis++) {
      const origin=start.getComponent(axis)-collider.center[axis];
      const delta=end.getComponent(axis)-start.getComponent(axis);
      const extent=collider.size[axis]/2+0.65;
      if(Math.abs(delta)<1e-9) {if(Math.abs(origin)>extent){far=-1;break;}}
      else {
        const lo=(-extent-origin)/delta,hi=(extent-origin)/delta;
        near=Math.max(near,Math.min(lo,hi));far=Math.min(far,Math.max(lo,hi));
      }
    }
    if(near<=far) return collider.penalty;
  }
  return null;
}

// Keep randomized boxes away from junk, pipe walls, and one another.
export function makeItemBoxes(obstacles:Obstacle[],random:()=>number) {
  return Array.from({length:14},(_,section)=>{
    const positions:Position[]=[];
    return Array.from({length:5},(_,index)=>{
      const y=-100-section*250-index%3*6;
      const clear=(x:number,z:number)=>positions.every(p=>Math.hypot(p[0]-x,p[2]-z)>=9)&&
        obstacles.every(o=>Math.abs(o.position[1]-y)>(o.kind==='duct'?30:12)||
          Math.hypot(o.position[0]-x,o.position[2]-z)>(o.kind==='duct'?19:10));
      let position:Position|undefined;
      for(let attempt=0;attempt<40;attempt++){
        const x=random()*56-28,z=random()*56-28;
        if(clear(x,z)){position=[x,y,z];break;}
      }
      // Bounded fallback also keeps seeded tests and unlucky rolls safe.
      if(!position)for(let x=-28;x<=28&&!position;x+=7)for(let z=-28;z<=28;z+=7){
        if(clear(x,z)){position=[x,y,z];break;}
      }
      if(!position)throw new Error('No clear item-box placement.');
      positions.push(position);
      return {id:section*5+index,position,rotation:[random()*Math.PI*2,random()*Math.PI*2,random()*Math.PI*2] as Position,active:true};
    });
  }).flat();
}

export function makeFuelRings(obstacles:Obstacle[],random:()=>number){
  return [300,1200].map((base,id)=>{
    const y=-base-random()*100;
    const clear=(x:number,z:number)=>obstacles.every(o=>Math.abs(o.position[1]-y)>(o.kind==='duct'?30:14)||
      Math.hypot(x-o.position[0],z-o.position[2])>(o.kind==='duct'?20:13));
    let position:Position|undefined;
    for(let attempt=0;attempt<60;attempt++){
      const x=random()*48-24,z=random()*48-24;
      if(clear(x,z)){position=[x,y,z];break;}
    }
    if(!position)for(let x=-24;x<=24&&!position;x+=6)for(let z=-24;z<=24;z+=6){
      if(clear(x,z)){position=[x,y,z];break;}
    }
    if(!position)throw new Error('No clear fuel-ring placement.');
    return {id,position,used:new Set<number>(),fuel:2};
  });
}
