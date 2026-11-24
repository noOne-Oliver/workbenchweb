# workbench 离线单包（{{TARGET}}）

这个包里带了跑起来需要的一切：node 运行时、workbench 内核、opencode 引擎二进制。
安装和运行都不联网，不需要 npm install，也不需要系统里先有 node。

- 目标平台：{{TARGET}}
- node：{{NODE_VERSION}}
- opencode：{{OPENCODE_VERSION}}
- 构建时间：{{BUILT_AT}}
- 内核：见 VERSIONS / kernel/package.json

## 一、安装

有 root（推荐，装到 /opt/workbench + systemd）：

    tar -xzf workbench-{{TARGET}}.tar.gz
    cd workbench-{{TARGET}}
    sudo ./install.sh

装到别的前缀、不碰 systemd（普通用户也能装）：

    ./install.sh --prefix "$HOME/workbench"

安装脚本会先用包里的 node 校验 SHA256SUMS，再复制文件；整个过程不联网。

## 二、配置

    sudo vi /etc/workbench/workbench.env     # 非 root：<prefix>/workbench.env

至少填三项（内网 OpenAI 兼容端点）：

    WB_LLM_BASE_URL=https://llm.internal.example/v1
    WB_LLM_MODEL=qwen3-coder-30b
    WB_LLM_API_KEY=sk-...

WB_HOME / WB_WORKSPACE / 端口 / 引擎都可以在这个文件里改，样例见 config.example.env。

## 三、体检与启动

    wb doctor      # 硬失败会 exit 2，并指出该改哪个文件
    wb up          # 后台起 server + worker，等 /api/health 通过
    wb status      # 进程 + 端口 + 执行器心跳
    wb logs -f     # 跟踪日志（<工作区>/.wb/*.log）

浏览器打开 http://<主机>:7317/ 。首次启动会在 server.log 里生成一次性口令：

    wb logs | grep 一次性口令

systemd 安装（install.sh 已装好 unit）：

    sudo systemctl enable --now workbench-server workbench-worker

## 四、目录

    bin/node            自带运行时
    bin/wb              控制台（doctor/up/down/status/logs/workspace）
    kernel/             内核（src、web、package.json）
    engine/opencode     引擎二进制（$WB_CODE/../engine/opencode）
    engine/VERSION      引擎版本
    licenses/           MIT / Apache-2.0 / NOTICE / 第三方 LICENSE
    SHA256SUMS          全部文件的 sha256（sha256sum -c 兼容：sha256sum -c SHA256SUMS）
    VERSIONS            这个包的版本清单
    install.sh          安装
    uninstall.sh        卸载
    config.example.env  配置样例

## 五、校验

包内自带 node，所以没有 sha256sum 的机器也能校验：

    ./bin/node -e 'const {createHash}=require("crypto"),{readFileSync}=require("fs");const re=/^([0-9a-f]{64}) +(.+)$/;let bad=0,n=0;for(const line of readFileSync("SHA256SUMS","utf8").trim().split("\n")){const m=line.match(re);if(!m){console.log("BAD-LINE",line);bad++;continue}n++;const got=createHash("sha256").update(readFileSync(m[2])).digest("hex");if(got!==m[1]){console.log("BAD",m[2]);bad++}}console.log(bad?("FAIL "+bad+" / "+n):("OK "+n+" files"))'

## 六、已知限制

- Linux 版要求 glibc ≥ {{GLIBC_FLOOR}}（内嵌引擎是 Bun 单文件，依赖 glibc 的 NSS/DNS 等符号）。
  musl（Alpine）不支持；要 musl 得单独做 musl 版包。
- 内核需要 node >= 22.5；包里自带的是 {{NODE_VERSION}}，别用系统 node 顶替。
- 引擎任务需要能访问 WB_LLM_BASE_URL；离线安装不等于离线推理。
- data/、.git、tests/、scripts/ 不在包里：工作区在运行时才建，代码与测试属于各业务仓库。

## 七、卸载

    sudo ./uninstall.sh            # 停服务、删 /opt/workbench 和 PATH 软链，保留工作区
    sudo ./uninstall.sh --purge    # 连工作区（账本、worktrees）一起删
