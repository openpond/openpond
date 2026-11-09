"""Bounded greedy inference through Transformers' canonical generation engine.

Each call owns a new KV cache. Callers install the exact candidate before entry
and retain the work reservation durably; no cache survives a candidate change.
"""
from __future__ import annotations

from .artifacts import require


def generate_greedy(model, tokenizer, messages, *, max_output_tokens, reserve, check,
                    maximum_context_tokens=8192):
    import torch
    from transformers import GenerationConfig, StoppingCriteria, StoppingCriteriaList

    check()
    ids = tokenizer.apply_chat_template(messages, tokenize=True, return_dict=False, add_generation_prompt=True,
                                        enable_thinking=False)
    require(isinstance(ids, list) and 0 < len(ids) <= maximum_context_tokens,
            'weight_space_prompt_tokens')
    require(type(max_output_tokens) is int and 0 < max_output_tokens <= 2048,
            'weight_space_output_tokens')
    eos = tokenizer.eos_token_id
    require(type(eos) is int and eos >= 0, 'weight_space_eos_token')
    work = 0

    def before_forward(context_length):
        nonlocal work
        check()
        require(context_length <= maximum_context_tokens, 'weight_space_context_limit')
        # Conservatively charge full attended context, including cached tokens.
        # Persist before dispatch so interruption never makes spent work free.
        reserve(context_length)
        work += context_length

    class ReserveNextForward(StoppingCriteria):
        def __call__(self, input_ids, scores, **kwargs):
            generated = input_ids.shape[1] - len(ids)
            finished = generated >= max_output_tokens or int(input_ids[0, -1]) == eos
            if not finished:
                before_forward(input_ids.shape[1])
            return torch.full((input_ids.shape[0],), finished, dtype=torch.bool, device=input_ids.device)

    # A fresh config also prevents checkpoint-specific sampling, repetition
    # penalties, constraints or beam settings from changing declared semantics.
    config = GenerationConfig(do_sample=False, num_beams=1, use_cache=True,
        max_new_tokens=max_output_tokens, eos_token_id=eos, pad_token_id=eos,
        bos_token_id=getattr(tokenizer, 'bos_token_id', None))
    tokens = torch.tensor([ids], device=model.device, dtype=torch.long)
    before_forward(len(ids))
    with torch.inference_mode():
        generated = model.generate(input_ids=tokens, attention_mask=torch.ones_like(tokens),
            generation_config=config, stopping_criteria=StoppingCriteriaList([ReserveNextForward()]))
    if tokens.device.type == 'cuda':
        torch.cuda.synchronize(tokens.device)
    check()
    output = generated[0, len(ids):].tolist()
    require(0 < len(output) <= max_output_tokens, 'weight_space_output_tokens')
    # Grade the completion text, while retaining every generated token ID as
    # evidence. Chat terminators must not become part of an expected answer.
    text = tokenizer.decode(output, skip_special_tokens=True, clean_up_tokenization_spaces=False)
    require(len(text) <= 65_536, 'weight_space_output_limit')
    return {'outputIds': output, 'outputText': text,
            'reachedTokenLimit': len(output) == max_output_tokens and output[-1] != eos,
            'forwardTokenWork': work}
