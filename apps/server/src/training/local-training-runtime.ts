import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { LocalTrainingRuntimeSchema, type LocalTrainingCompute } from "@openpond/contracts/resource-setup";

const execFileAsync = promisify(execFile);

const probe = String.raw`
import json
import sys
from contextlib import redirect_stdout
from importlib.metadata import version

def inspect():
    try:
        import torch
        from accelerate import Accelerator
        from peft import LoraConfig, get_peft_model
        from safetensors.torch import load_file, save_file
        from transformers import AutoModelForCausalLM, AutoTokenizer, Trainer
        packages = {
            name: version(name)
            for name in ("torch", "transformers", "peft", "accelerate", "safetensors")
        }
    except Exception:
        return {"status": "dependencies_missing"}

    if not torch.version.cuda or not torch.cuda.is_available():
        return {"status": "cuda_unusable"}

    devices = []
    for ordinal in range(min(torch.cuda.device_count(), 256)):
        try:
            with torch.cuda.device(ordinal):
                sample = torch.ones((16, 16), device="cuda", dtype=torch.float16, requires_grad=True)
                (sample @ sample).sum().backward()
                torch.cuda.synchronize()
                free, total = torch.cuda.mem_get_info()
                devices.append({
                    "ordinal": ordinal,
                    "device": {
                        "name": torch.cuda.get_device_name(),
                        "memoryMiB": total // 1048576,
                        "freeMiB": free // 1048576,
                    },
                    "computeCapability": torch.cuda.get_device_capability(),
                })
                del sample
        except (RuntimeError, AssertionError):
            continue
    if not devices:
        return {"status": "cuda_unusable"}
    return {
        "status": "ready",
        "python": ".".join(map(str, sys.version_info[:3])),
        "cuda": torch.version.cuda,
        "packages": packages,
        "devices": devices,
    }

with redirect_stdout(sys.stderr):
    report = inspect()
print(json.dumps(report))
`;

export async function inspectLocalTrainingRuntime(storeDir: string): Promise<NonNullable<LocalTrainingCompute["runtime"]>> {
  if (process.platform !== "linux") return { status: "unsupported_platform" };
  const directory = path.resolve(storeDir, "training", "local-runtime");
  try {
    const { stdout } = await execFileAsync(path.join(directory, "bin", "python"), ["-I", "-B", "-c", probe], {
      cwd: directory,
      env: {
        PATH: process.env.PATH,
        LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH,
        CUDA_VISIBLE_DEVICES: process.env.CUDA_VISIBLE_DEVICES,
        CUDA_DEVICE_ORDER: process.env.CUDA_DEVICE_ORDER,
        HOME: directory,
        HF_HUB_OFFLINE: "1",
        HF_HUB_DISABLE_TELEMETRY: "1",
        TRANSFORMERS_OFFLINE: "1",
        WANDB_MODE: "disabled",
      },
      timeout: 12_000,
      killSignal: "SIGKILL",
      maxBuffer: 128_000,
    });
    return LocalTrainingRuntimeSchema.parse(JSON.parse(stdout));
  } catch (error) {
    return { status: (error as NodeJS.ErrnoException).code === "ENOENT" ? "python_missing" : "probe_failed" };
  }
}
