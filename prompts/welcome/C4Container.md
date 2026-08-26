```markdown
C4Container
    title 大型跨境电商平台 - 容器级架构全景

    Person(buyer, "买家", "通过 Web/App 浏览、下单、支付的终端用户")
    Person(seller, "卖家", "入驻平台并管理商品、库存、订单的商家")
    Person(operator, "平台运营", "负责商品审核、活动配置、风控的内部员工")

    System_Ext(payment, "第三方支付方", "支付宝、微信支付、Stripe、PayPal 等外部支付通道")
    System_Ext(logistics, "第三方物流", "顺丰、DHL、FedEx 等物流轨迹查询接口")
    System_Ext(sms, "短信网关", "阿里云/腾讯云短信通知服务")

    System_Boundary(c1, "跨境电商平台") {
        Container(web, "Web 前端", "React + Next.js", "面向买家的 PC 端门户,SSR 渲染商品详情与营销活动页")
        Container(app, "移动 App", "Flutter", "iOS/Android 客户端,集成推送、扫码、定位")
        Container(admin, "商家后台", "Vue + Element Plus", "卖家与运营共用的管理后台,商品/订单/促销/风控")
        Container(gateway, "API 网关", "Kong + OAuth2.1", "统一接入、限流、鉴权、路由与跨域")
        Container(ucenter, "用户中心", "Spring Boot + MyBatis", "账号/实名/会员等级/地址簿/登录态")
        Container(prod, "商品服务", "Spring Boot + Elasticsearch", "商品 SPU/SKU、类目、属性、搜索与详情")
        Container(order, "订单服务", "Spring Boot + Seata", "下单、支付编排、拆单、状态机、退换")
        Container(stock, "库存服务", "Spring Boot + Redis", "实时库存、预占、扣减、回滚、对账")
        Container(pay, "支付服务", "Spring Boot + 策略模式", "聚合多家支付通道、签名验签、对账回调")
        Container(search, "搜索服务", "Elasticsearch + IK 分词", "全文检索、聚合筛选、个性化排序")
        Container(recommend, "推荐服务", "Python + Faiss 向量检索", "首页 Feed、详情页相关推荐、千人千面")
        Container(mq, "消息队列", "Kafka + RocketMQ", "订单/支付/库存事件解耦、削峰、可靠投递")
        Container(cache, "分布式缓存", "Redis Cluster + Codis", "热点商品、Session、令牌桶限流")
        Container(db, "MySQL 主从", "MySQL 8 + MHA", "用户/商品/订单核心业务数据,1 主 3 从读写分离")
        Container(oss, "对象存储", "MinIO + CDN", "商品图片、视频、用户头像、运营素材")

        ContainerDb(user_db, "用户库", "MySQL 8", "账号、会员、地址、登录态")
        ContainerDb(prod_db, "商品库", "MySQL 8", "SPU/SKU、类目、品牌、属性")
        ContainerDb(order_db, "订单库", "MySQL 8 分库分表", "订单主表、明细、状态、日志")
        ContainerDb(stock_db, "库存库", "MySQL 8", "仓库- SKU 维度库存流水")
        ContainerDb(pay_db, "支付库", "MySQL 8", "支付流水、对账记录")
    }

    Rel(buyer, web, "浏览商品、下单、支付", "HTTPS")
    Rel(buyer, app, "浏览、下单、扫码、消息推送", "HTTPS/APNs")
    Rel(seller, admin, "商品上下架、订单履约、促销配置", "HTTPS")
    Rel(operator, admin, "审核、活动、风控、数据看板", "HTTPS")

    Rel(web, gateway, "统一接入 API", "HTTPS/JSON")
    Rel(app, gateway, "统一接入 API", "HTTPS/JSON")
    Rel(admin, gateway, "后台 API 调用", "HTTPS/JSON")

    Rel(gateway, ucenter, "鉴权 / 用户信息查询", "RPC")
    Rel(gateway, prod, "商品查询、详情", "RPC")
    Rel(gateway, order, "下单、订单查询", "RPC")
    Rel(gateway, pay, "发起支付、查单", "RPC")
    Rel(gateway, search, "搜索建议、过滤项", "RPC")

    Rel(order, stock, "预占/扣减/回滚库存", "RPC + Kafka 异步对账")
    Rel(order, pay, "创建支付单、查支付状态", "RPC")
    Rel(order, mq, "发布订单事件 (OrderCreated/Paid/Cancelled)", "Kafka")
    Rel(order, recommend, "下单回传特征用于推荐训练", "Kafka")

    Rel(pay, payment, "跳转/扫码/SDK 支付", "HTTPS")
    Rel(payment, pay, "支付结果回调", "HTTPS/Webhook")
    Rel(pay, mq, "发布支付成功事件", "Kafka")
    Rel(pay, sms, "支付成功通知", "HTTPS")

    Rel(prod, search, "商品变更同步索引", "Kafka/RocketMQ")
    Rel(prod, recommend, "商品特征同步", "Kafka")
    Rel(recommend, cache, "读个性化召回结果", "Redis")
    Rel(search, cache, "读热点词与聚合缓存", "Redis")

    Rel(order, oss, "电子凭证、发票 PDF 存储", "S3 兼容 API")
    Rel(admin, oss, "上传商品图与视频素材", "S3 兼容 API")
    Rel(ucenter, sms, "注册/登录/异常告警短信", "HTTPS")
    Rel(order, logistics, "物流轨迹查询", "HTTPS")

    Rel(ucenter, user_db, "读写", "JDBC")
    Rel(prod, prod_db, "读写", "JDBC")
    Rel(order, order_db, "读写", "JDBC")
    Rel(stock, stock_db, "读写", "JDBC")
    Rel(pay, pay_db, "读写", "JDBC")

    UpdateRelStyle(buyer, web, $offsetY="-10")
    UpdateRelStyle(buyer, app, $offsetY="-10")
    UpdateLayoutConfig($c4ShapeInRow="3", $c4BoundaryInRow="1")
```
