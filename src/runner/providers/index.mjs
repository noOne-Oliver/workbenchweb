import { registerProvider } from "../engine.mjs";
import createMock from "./mock.mjs";
import createOpencode from "./opencode.mjs";
import createStage from "./stage.mjs";
import { wrapProvider } from "./faulty.mjs";

// 故障注入只在外壳这一层包，provider 本身不知道自己在被测（也就不会为了"过关"而配合）。
const FAULT = process.env.WB_FAULT;

registerProvider("mock", async (opts) => wrapProvider(await createMock(opts), FAULT));
registerProvider("opencode", async (opts) => wrapProvider(await createOpencode(opts), FAULT));
// 演示/测试用的「按阶段产出」引擎：不联网，但会真的写文件、真的被护栏检查。
registerProvider("stage", async (opts) => wrapProvider(await createStage(opts), FAULT));

export const BUILTIN_ENGINES = ["mock", "stage", "opencode"];
