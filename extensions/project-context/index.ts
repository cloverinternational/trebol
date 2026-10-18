import { trebolFactory } from "../../.pi/lib/runtime/trebol-toggle.ts";
export default trebolFactory(() => import("./extension.ts"));
