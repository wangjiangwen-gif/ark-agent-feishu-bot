"""mock NIO 业务数据：按 open_id 分桶，演示「OpenID 透传后按用户返回专属数据」。

真实环境这些数据来自 NIO 内部系统；这里用内存字典 mock。
"""
from __future__ import annotations

# 白名单 + 每用户专属数据。open_id 以约定后缀区分角色（与 role.mock_hr_provider 对应）。
USER_DATA: dict[str, dict] = {
    "ou-demo-manager": {
        "name": "王经理",
        "role": "销售经理",
        "store": "上海浦东蔚来中心",
        "leads": [
            {"customer": "张先生", "model": "ET9", "stage": "已下定", "owner": "李顾问"},
            {"customer": "陈女士", "model": "ES6", "stage": "试驾", "owner": "赵顾问"},
        ],
        "kpi": {"month_target": 40, "month_done": 27, "team_size": 8},
    },
    "ou-demo-sales": {
        "name": "李顾问",
        "role": "销售顾问",
        "store": "上海浦东蔚来中心",
        "leads": [
            {"customer": "张先生", "model": "ET9", "stage": "已下定"},
            {"customer": "刘先生", "model": "ET5", "stage": "初次到店"},
        ],
        "kpi": {"month_target": 6, "month_done": 4},
    },
}

# 车型知识库（与用户无关，任何授权用户可查）。
VEHICLE_CATALOG = {
    "ET9": {"positioning": "行政旗舰轿车", "range_km": 700, "highlight": "线控转向 + 天行底盘"},
    "ES6": {"positioning": "中型智能电动 SUV", "range_km": 625, "highlight": "家用全能"},
    "ET5": {"positioning": "中型智能电动轿跑", "range_km": 560, "highlight": "年轻人首台蔚来"},
}


def is_authorized(open_id: str) -> bool:
    return open_id in USER_DATA


def get_user_bucket(open_id: str) -> dict:
    return USER_DATA[open_id]
