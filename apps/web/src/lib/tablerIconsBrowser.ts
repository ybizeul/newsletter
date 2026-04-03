import * as TablerIcons from "@tabler/icons-react";
import type React from "react";

export type TablerIconMap = Record<string, React.ComponentType<{ size?: number }>>;

export const TABLER_ICON_MAP = TablerIcons as unknown as TablerIconMap;
