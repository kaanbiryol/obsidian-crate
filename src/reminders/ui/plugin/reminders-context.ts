import { makeContext } from "@/ui/plugin/plugin-context";

type ModalInfo = {
	close: () => void;
	isMobile: boolean;
};

export const ModalContext = makeContext<ModalInfo>();
