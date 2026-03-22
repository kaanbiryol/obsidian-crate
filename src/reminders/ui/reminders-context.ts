import { createContext, type Provider, useContext } from "react";
import type CratePlugin from "@/main";

type Context<T> = {
  Provider: Provider<T | undefined>;
  use: () => T;
};

const makeContext = <T>(): Context<T> => {
  const context = createContext<T | undefined>(undefined);
  const use = () => {
    const ctx = useContext(context);

    if (ctx === undefined) {
      throw new Error("Context provider not found");
    }

    return ctx;
  };
  return { Provider: context.Provider, use };
};

export const PluginContext = makeContext<CratePlugin>();

type ModalInfo = {
  close: () => void;
  popoverContainerEl: HTMLElement;
  isMobile: boolean;
};

export const ModalContext = makeContext<ModalInfo>();

