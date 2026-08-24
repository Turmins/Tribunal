export type Indictment={defendant:string;act:string;question:string};
export async function createCase(indictment:Indictment,panel?:string):Promise<any>{const key=crypto.randomUUID();const r=await fetch("/api/v1/cases",{method:"POST",headers:{"content-type":"application/json","idempotency-key":key},body:JSON.stringify(panel?{indictment,panel}:{indictment})});const b=await r.json();if(!r.ok)throw b;return b}
export async function getCase(id:string):Promise<any>{const r=await fetch(`/api/v1/cases/${id}`);if(!r.ok)throw await r.json();return r.json()}
export async function getCases():Promise<any>{const r=await fetch("/api/v1/cases");if(!r.ok)throw await r.json();return r.json()}
export async function getPanels():Promise<any>{const r=await fetch("/api/v1/panels");if(!r.ok)throw await r.json();return r.json()}
