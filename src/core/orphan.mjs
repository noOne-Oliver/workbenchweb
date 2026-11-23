/**
 * 父进程看门狗。
 *
 * 为什么需要它：app 被 `kill -9` 时，它起的 server/worker 会被 launchd 收养（ppid 变 1），
 * 没人通知它们退出 —— 端口一直占着，下次启动的 app 会 attach 到这只僵尸内核上，
 * 看到的是上一次的工作区和账本（这是实测踩到的坑，见 tests/orphan.test.mjs）。
 *
 * 做法：app 启动子进程时注入 WB_PARENT_PID；子进程每 intervalMs 看一眼自己的 ppid 还是不是它。
 * 不是就说明父进程已经没了，主动收工。手动从终端起（没有 WB_PARENT_PID）时完全不启用。
 */
export function watchParent({ intervalMs = 3000, log = () => {} } = {}) {
  const expected = Number(process.env.WB_PARENT_PID || 0);
  if (!Number.isInteger(expected) || expected <= 0) return null;
  const timer = setInterval(() => {
    if (process.ppid === expected) return;
    clearInterval(timer);
    log("父进程 " + expected + " 已退出（当前 ppid=" + process.ppid + "），主动收工");
    process.exit(0);
  }, intervalMs);
  timer.unref();
  return timer;
}
