```markdown
sequenceDiagram
    autonumber
    participant Client as 客户端
    participant AppCtx as ApplicationContext
    participant Registry as BeanDefinitionRegistry
    participant BF as BeanFactory
    participant BPP as BeanPostProcessor
    participant Target as 目标 Bean

    Note over AppCtx,Registry: 容器启动阶段 加载配置并注册 BeanDefinition
    AppCtx->>Registry: invokeBeanFactoryPostProcessors / loadBeanDefinitions
    activate Registry
    Registry->>Registry: 解析 XML / @Configuration / @ComponentScan
    Registry->>Registry: 扫描并封装 BeanDefinition
    Registry-->>AppCtx: BeanDefinition 注册完成
    deactivate Registry

    Note over Client,Target: 客户端 getBean 触发懒加载
    Client->>AppCtx: getBean("userService")
    activate AppCtx
    AppCtx->>BF: getSingleton(beanName)
    activate BF

    alt 单例已存在 缓存命中
        BF-->>AppCtx: 直接返回缓存中的单例 Bean
        Note right of BF: 走缓存快速路径 不再走生命周期
    else 首次创建 Bean
        BF->>Registry: getBeanDefinition(beanName)
        activate Registry
        Registry-->>BF: 返回 BeanDefinition
        deactivate Registry

        Note over BF,Target: 反射构造实例
        BF->>BF: createBeanInstance(ctor.newInstance)
        activate Target
        BF->>Target: constructor 反射创建原始对象
        Target-->>BF: 原始对象 未注入属性
        deactivate Target
        BF->>BF: 暴露早期引用到三级缓存 singletonFactories

        Note over BF,Target: 属性注入阶段 @Autowired
        BF->>BF: populateBean / resolveDependency
        loop 循环依赖检查与依赖解析
            BF->>BF: getBean(依赖 bean)
            alt 检测到循环依赖
                BF->>BF: 从三级缓存获取早期引用 ObjectFactory.getObject
            end
        end
        BF->>Target: 字段注入 @Autowired / @Value
        activate Target
        Target-->>BF: 属性注入完成
        deactivate Target

        Note over BF,Target: Aware 接口回调
        BF->>Target: BeanNameAware.setBeanName
        activate Target
        Target-->>BF: 完成
        deactivate Target
        BF->>Target: BeanFactoryAware.setBeanFactory
        activate Target
        Target-->>BF: 完成
        deactivate Target
        BF->>Target: ApplicationContextAware.setApplicationContext
        activate Target
        Target-->>BF: 完成
        deactivate Target

        Note over BF,BPP: BeanPostProcessor 前置处理 扩展点
        BF->>BPP: postProcessBeforeInitialization
        activate BPP
        BPP-->>BF: 返回处理后对象
        deactivate BPP

        Note over BF,Target: 初始化阶段 扩展点
        BF->>Target: @PostConstruct 方法调用
        activate Target
        Target-->>BF: @PostConstruct 执行完毕
        deactivate Target
        BF->>Target: afterPropertiesSet InitializingBean
        activate Target
        Target-->>BF: InitializingBean 回调完成
        deactivate Target

        Note over BF,BPP: BeanPostProcessor 后置处理 生成 AOP 代理
        BF->>BPP: postProcessAfterInitialization
        activate BPP
        BPP->>BPP: wrapIfNecessary / createAopProxy
        BPP-->>BF: 返回 AOP 代理对象
        deactivate BPP

        BF->>BF: 放入一级缓存 singletonObjects
        BF-->>AppCtx: 返回代理 Bean
    end
    deactivate BF
    AppCtx-->>Client: 返回代理对象 客户端拿到的是 Proxy
    deactivate AppCtx
```