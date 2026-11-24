# dsh-cost-tier

安装：`dsh plugin --profile web add @ericality/dsh-cost-tier@0.1.0`


时段规则库：高峰与低谷判定的单点实现，附节假日表与官方定价页锚点解析。

安装：`dsh plugin --profile web add @ericality/dsh-cost-tier@0.1.0`

## 导出

- `tierOf`、`isBeijingPeak`、`bjParts`：按北京时间判断当前时段，含头不含尾。
- `isCnHoliday`：查表判断法定节假日；表外年份返回 `null` 并计入降级。
- `tierInfo`、`healthState`、`parsePeakWindows`：时段说明、健康态与高峰窗口解析。
- `probe`：返回库自身健康度，供调用方如实上报。

## 数据

节假日表随包发布在 `data/cn-holidays.json`，可用环境变量 `DSH_COST_TIER_HOLIDAYS` 指向新年度文件，无需改代码。

## 形态

纯函数库，无 ctx、无网络、零第三方依赖，顶层不抛异常。宿主包只作为 peer 声明。

## 许可

BSD-3-Clause
