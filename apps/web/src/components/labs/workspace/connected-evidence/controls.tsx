import type { ComponentProps } from "react";
export function Button({ variant, ...props }: ComponentProps<"button"> & { variant?: string }) { return <button {...props} type={props.type ?? "button"} className={variant ? "training-button secondary" : "training-button"} />; }
export function Input(props: ComponentProps<"input">) { return <input {...props} />; }
