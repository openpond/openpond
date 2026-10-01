import type { ExperimentSetupDraft } from "./EvaluationSetupState";

export function ExperimentAdvancedSettings({draft,patch,supportsSampling,profileSeeds}:{draft:ExperimentSetupDraft;patch:(value:Partial<ExperimentSetupDraft>)=>void;supportsSampling:boolean;profileSeeds?:string[]}) {
  const profile=draft.mode==="model_harness_profile";
  const overrides=draft.temperature!==undefined||draft.topP!==undefined;
  return <details><summary>Advanced settings</summary>
    {profile?<><p>Profile execution uses its exact released model configuration and evaluation seeds. Its execution owner prepares those pins.</p>{profileSeeds?<p>Released seeds: {profileSeeds.join(", ")}</p>:null}</>:<>
      {supportsSampling||overrides?<><label><input type="checkbox" checked={overrides} disabled={!supportsSampling&&!overrides} onChange={event=>patch(event.target.checked?{temperature:0,topP:1}:{temperature:undefined,topP:undefined})}/>Override sampling</label>
        {overrides?<><label>Temperature<input type="number" min="0" max="2" step="0.1" disabled={!supportsSampling} value={draft.temperature??0} onChange={event=>patch({temperature:Number(event.target.value)})}/></label><label>Top P<input type="number" min="0.01" max="1" step="0.01" disabled={!supportsSampling} value={draft.topP??1} onChange={event=>patch({topP:Number(event.target.value)})}/></label>{!supportsSampling?<p>This model does not support sampling overrides. Clear the override to continue.</p>:null}</>:null}
      </>:null}
      <label>Maximum output tokens<input type="number" min="1" max="4096" value={draft.outputTokens} onChange={event=>patch({outputTokens:Number(event.target.value)})}/></label>
      <label>Environment seeds<input inputMode="text" value={draft.seed} onChange={event=>patch({seed:event.target.value})}/><small>Separate seeds with commas. Unchanged existing membership keeps each original task and seed pair.</small></label>
      <label>System instructions<textarea value={draft.prompt} onChange={event=>patch({prompt:event.target.value})} rows={6}/></label>
      {draft.mode==="model_harness"?<p>Released Harness instructions are immutable; additional system instructions must be empty.</p>:null}
    </>}
  </details>;
}
