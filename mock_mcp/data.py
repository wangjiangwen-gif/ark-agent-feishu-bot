"""mock NIO 业务数据：按 open_id 分桶，演示「OpenID 透传后按用户返回专属数据」。

真实环境这些数据来自 NIO 内部系统；这里用内存字典 mock。
"""
from __future__ import annotations

# 数据权限（后端权威）：卡点 C 硬拦截以此为准，不认对话层声称的岗位。
PERM_VIEW_OWN_LEADS = "view_own_leads"        # 查自己的线索/业绩
PERM_VIEW_TEAM_PIPELINE = "view_team_pipeline"  # 查团队销售漏斗
PERM_APPROVE_DISCOUNT = "approve_discount"    # 审批折扣

# 白名单 + 每用户专属数据。open_id 以约定后缀区分角色（与 role.mock_hr_provider 对应）。
# permissions 是后端权威权限位，get_team_pipeline 等敏感工具以此校验。
USER_DATA: dict[str, dict] = {
    # 真机 demo 账号：绑定到「上海浦东蔚来中心」销售经理，用于端到端演示卡点 B（OpenID 透传）。
    "ou_237bfabd66a08f7b90b8682db9ae3017": {
        "name": "俞麟",
        "role": "销售经理",
        "store": "上海浦东蔚来中心",
        "permissions": [PERM_VIEW_OWN_LEADS, PERM_VIEW_TEAM_PIPELINE, PERM_APPROVE_DISCOUNT],
        "leads": [
            {"customer": "周先生", "model": "ET9", "stage": "已下定", "owner": "李顾问"},
            {"customer": "吴女士", "model": "ES6", "stage": "已到店", "owner": "赵顾问"},
            {"customer": "郑先生", "model": "ET5", "stage": "待跟进", "owner": "孙顾问"},
        ],
        "kpi": {"month_target": 45, "month_done": 31, "team_size": 9},
    },
    "ou-demo-manager": {
        "name": "王经理",
        "role": "销售经理",
        "store": "上海浦东蔚来中心",
        "permissions": [PERM_VIEW_OWN_LEADS, PERM_VIEW_TEAM_PIPELINE, PERM_APPROVE_DISCOUNT],
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
        "permissions": [PERM_VIEW_OWN_LEADS],
        "leads": [
            {"customer": "张先生", "model": "ET9", "stage": "已下定"},
            {"customer": "刘先生", "model": "ET5", "stage": "初次到店"},
        ],
        "kpi": {"month_target": 6, "month_done": 4},
    },
}

# 门店级团队销售漏斗（敏感数据，仅有 view_team_pipeline 权限者可查）。按门店聚合。
TEAM_PIPELINE: dict[str, dict] = {
    "上海浦东蔚来中心": {
        "store": "上海浦东蔚来中心",
        "funnel": [
            {"stage": "线索", "count": 128},
            {"stage": "到店", "count": 76},
            {"stage": "试驾", "count": 52},
            {"stage": "下定", "count": 31},
            {"stage": "交付", "count": 24},
        ],
        "members": [
            {"name": "李顾问", "month_done": 8, "month_target": 10},
            {"name": "赵顾问", "month_done": 6, "month_target": 10},
            {"name": "孙顾问", "month_done": 5, "month_target": 8},
        ],
        "month_target": 45,
        "month_done": 31,
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


def has_permission(open_id: str, permission: str) -> bool:
    """后端权威权限校验：open_id 必须在白名单且其 permissions 含该权限位。"""
    bucket = USER_DATA.get(open_id)
    return bool(bucket) and permission in bucket.get("permissions", [])


def get_team_pipeline_for_store(store: str) -> dict | None:
    return TEAM_PIPELINE.get(store)
