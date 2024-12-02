+++
date = '2022-12-15T16:00:20+08:00'
title = '认识MQTT（二）：RabbitMQ支持MQTT'
draft = false
mermaid = true
categories = ['消息队列']
tags = ['消息队列', '通信协议']
+++

`RabbitMQ`是通过插件的形式支持`MQTT`协议的，使用时，需要在RabbitMQ集群上启用`rabbitmq_mqtt`插件。

## 一、如何配置RabbitMQ以支持MQTT的QoS级别

`MQTT` QoS级别在`RabbitMQ`中不需要特别的配置，因为`rabbitmq_mqtt`插件会自动处理QoS级别。`MQTT`客户端在发布消息时指定QoS级别，`RabbitMQ`会根据这个级别处理消息。

**AMQP和MQTT的QoS映射**：
* MQTT QoS 0对应于“至多一次”的消息传递，AMQP中没有直接对应的QoS级别。
* MQTT QoS 1对应于“至少一次”的消息传递，AMQP中可以通过消息确认机制实现。
* MQTT QoS 2对应于“只有一次”的消息传递，AMQP中可以通过事务或具有唯一消息ID的队列实现。

{{< mermaid bc="#white" >}}
graph LR
    A[1. 配置RabbitMQ以支持MQTT QoS] --> B[启用MQTT插件]
    A --> C[2. 配置持久化]
    A --> D[3. 配置手动消息确认]
    A --> E[4. 配置死信队列]
    A --> F[5. 配置集群和高可用性]
    A --> G[6. 配置TLS/SSL]
    
    B --> B1["启用命令：rabbitmq-plugins enable rabbitmq_mqtt"]
    C --> C1["设置消息和队列持久化"]
    D --> D1["确保客户端确认消息"]
    E --> E1["配置DLX（死信交换机）"]
    F --> F1["跨多个节点部署RabbitMQ"]
    G --> G1["配置TLS/SSL以加密传输"]
{{< /mermaid >}}

## 二、如何确保RabbitMQ中的MQTT消息不会被丢失

确保RabbitMQ中MQTT消息不丢失，需要综合考虑消息的持久性、网络通信的可靠性、消息确认机制等多个方面。

{{< mermaid bc="#white" >}}
graph LR
    A[确保RabbitMQ中MQTT消息不丢失]
    A --> B[1. 消息持久化]
    B --> B1["持久化队列 - 队列持久化策略"]
    B --> B2["持久化消息 - 消息持久化标记"]
    A --> C[2. 网络通信的可靠性]
    C --> C1["使用TLS/SSL - 加密传输层"]
    A --> D[3. 消息确认机制]
    D --> D1["手动确认 - 消费者确认消息处理完成"]
    A --> E[4. 配置死信队列]
    E --> E1["死信队列 - 存储处理失败的消息"]
    A --> F[5. 集群和高可用性]
    F --> F1["集群部署 - 跨多个节点部署RabbitMQ"]
    A --> G[6. 监控和报警]
    G --> G1["监控 - 使用管理界面监控"]
    G --> G2["报警 - 配置报警机制"]
    A --> H[7. 合理配置QoS]
    H --> H1["配置MQTT QoS级别 - 设置消息传递的服务质量"]
    A --> I[8. 避免消息过期]
    I --> I1["设置消息过期时间TTL - 定义消息的最大存活时间"]
{{< /mermaid >}}

## 三、如何确保RabbitMQ中的MQTT消息的顺序性

{{< mermaid bc="#white" >}}
graph LR
    A[确保RabbitMQ中MQTT消息顺序性] --> B[1. 持久化消息和队列]
    A --> C[2. 单个消费者处理]
    A --> D[3. 非自动确认消息]
    A --> E[4. 预取计数设置为1]
    A --> F[5. 使用事务]
    A --> G[6. 避免消息选择性消费]
    A --> H[7. 确保网络可靠性]
    A --> I[8. 监控和报警]
    
    B --> B1["队列和消息持久化设置"]
    C --> C1["确保队列只有一个活跃消费者"]
    D --> D1["手动确认消息"]
    E --> E1["设置prefetch count为1"]
    F --> F1["使用tx_select和tx_commit"]
    G --> G1["按顺序消费消息"]
    H --> H1["使用TLS/SSL加密"]
    I --> I1["实施监控和报警机制"]
{{< /mermaid >}}

## 四、如何确保RabbitMQ中的MQTT消息持久化
{{< mermaid bc="#white" >}}
graph LR
    A[确保RabbitMQ中MQTT消息持久化] --> B[1. 启用MQTT插件]
    A --> C[2. 配置持久化队列]
    A --> D[3. 标记消息为持久化]
    A --> E[4. 确保消息确认]
    A --> F[5. 配置死信队列]
    A --> G[6. 监控和日志]
    A --> H[7. 集群部署]
    
    B --> B1["rabbitmq-plugins enable rabbitmq_mqtt"]
    C --> C1["使用rabbitmqctl set_policy配置队列"]
    D --> D1["客户端发布消息时设置持久化"]
    E --> E1["使用QoS 1或2确保消息确认"]
    F --> F1["配置DLX处理无法消费的消息"]
    G --> G1["实施监控和日志记录策略"]
    H --> H1["跨多个节点部署RabbitMQ"]
{{< /mermaid >}}