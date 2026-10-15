import { desktopScenario } from "../../scripts/desktop-harness/scenario.js";

// A delayed first-run dialog must not take focus from work already being typed.
// Explicit setup requests remain available while an editable owns focus.
export default desktopScenario({
  name: "onboarding-editable-focus", mode: "isolated", timeoutMs: 45_000,
  async run(harness) {
    const result = await harness.renderer.evaluate<Record<string, boolean>>(`(async()=>{
      const dialog=()=>document.querySelector('[role="dialog"][aria-label="Get started with OpenPond"]');
      const wait=async(predicate)=>{for(let i=0;i<250;i++){if(predicate())return;await new Promise(r=>setTimeout(r,50));}throw Error('Setup focus lifecycle timed out');};
        await wait(()=>!!document.querySelector('.composer-inline-input'));
        const input=document.querySelector('.composer-inline-input');
        input.focus();document.execCommand('insertText',false,'Unsent draft');
        await new Promise(r=>setTimeout(r,6500));
        const deferred=!dialog()&&document.activeElement===input&&input.textContent==='Unsent draft';
        document.querySelector('nav[aria-label="Desktop destinations"] button').focus();await wait(()=>!!dialog());
        document.querySelector('[aria-label="Close get started"]').click();await wait(()=>!dialog());
        input.focus();window.dispatchEvent(new Event('openpond:open-get-started'));await wait(()=>!!dialog());
        const explicit=!!dialog()&&input.textContent==='Unsent draft';
        document.querySelector('[aria-label="Close get started"]').click();await wait(()=>!dialog());
        return {scheduledSetupPreservesEditable:deferred,explicitSetupRemainsAvailable:explicit};
    })()`);
    for (const [name, passed] of Object.entries(result)) {
      harness.recordAssertion(name, passed);
      if (!passed) throw new Error(`Onboarding focus lifecycle failed: ${name}`);
    }
  },
});
