import classNames from "classnames";
import { setIcon } from "obsidian";
import type React from "react";
import { useEffect, useRef } from "react";
import type { ThemeIconProps } from "../theme-icon";
import "./styles.scss";

type Props = ThemeIconProps & Omit<React.HTMLAttributes<HTMLDivElement>, "size" | "id" | "className">;

export const ObsidianIcon: React.FC<Props> = ({ size, id, className, ...rest }) => {
  const div = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (div.current === null) {
      return;
    }

    setIcon(div.current, id);
  }, [id]);

  return (
    <div
      className={classNames("obsidian-icon", className)}
      data-icon={id}
      data-icon-size={size}
      ref={div}
      {...rest}
    />
  );
};
