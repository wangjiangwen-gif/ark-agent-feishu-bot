"""TTY 掩码输入：读取密钥时以 • 回显，支持退格与 Ctrl-C。

移植自原 TS 项目 src/cli.ts 的 readMaskedInput。
"""
from __future__ import annotations

import sys


def read_masked_input(prompt: str) -> str:
    """在终端 raw 模式下逐字符读取一行，回显 • 而非明文。

    仅在真实 TTY 下可用；非 TTY 会抛错，与原实现一致。
    """
    if not sys.stdin.isatty():
        raise RuntimeError("安全输入需要在终端中运行")

    import termios
    import tty

    sys.stdout.write(prompt)
    sys.stdout.flush()

    fd = sys.stdin.fileno()
    old_settings = termios.tcgetattr(fd)
    chars: list[str] = []
    try:
        tty.setraw(fd)
        while True:
            ch = sys.stdin.read(1)
            if ch in ("\r", "\n"):  # 回车结束
                break
            if ch == "\x03":  # Ctrl-C
                raise KeyboardInterrupt("初始化已取消")
            if ch in ("\x7f", "\b"):  # 退格
                if chars:
                    chars.pop()
                    sys.stdout.write("\b \b")
                    sys.stdout.flush()
                continue
            if ch < " ":  # 其余控制字符忽略
                continue
            chars.append(ch)
            sys.stdout.write("•")
            sys.stdout.flush()
    finally:
        termios.tcsetattr(fd, termios.TCSADRAIN, old_settings)
        sys.stdout.write("\n")
        sys.stdout.flush()
    return "".join(chars)
