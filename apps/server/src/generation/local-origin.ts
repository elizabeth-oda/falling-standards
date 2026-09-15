export function isLocalOrigin(value:string|undefined):boolean {
  if (value===undefined) return true; // Non-browser local tools may omit Origin.
  try {
    const origin=new URL(value);
    return origin.origin===value && ['http:','https:'].includes(origin.protocol)
      && ['localhost','127.0.0.1','[::1]'].includes(origin.hostname);
  } catch {return false;}
}
