---
title: "认识MQTT（二）：RabbitMQ支持MQTT"
date: 2022-12-15
category: mq
tags: ["消息队列", "通信协议"]
description: "`RabbitMQ`是通过插件的形式支持`MQTT`协议的，使用时，需要在RabbitMQ集群上启用`rabbitmq_mqtt`插件。    ## 一、如何配置RabbitMQ以支持MQTT的QoS..."
---



`RabbitMQ`是通过插件的形式支持`MQTT`协议的，使用时，需要在RabbitMQ集群上启用`rabbitmq_mqtt`插件。

<!--more-->

## 一、如何配置RabbitMQ以支持MQTT的QoS级别

`MQTT` QoS级别在`RabbitMQ`中不需要特别的配置，因为`rabbitmq_mqtt`插件会自动处理QoS级别。`MQTT`客户端在发布消息时指定QoS级别，`RabbitMQ`会根据这个级别处理消息。

**AMQP和MQTT的QoS映射**：
* MQTT QoS 0对应于“至多一次”的消息传递，AMQP中没有直接对应的QoS级别。
* MQTT QoS 1对应于“至少一次”的消息传递，AMQP中可以通过消息确认机制实现。
* MQTT QoS 2对应于“只有一次”的消息传递，AMQP中可以通过事务或具有唯一消息ID的队列实现。



![Mermaid 图表](/images/mermaid/mermaid-34c2bb68-0.svg)



## 二、如何确保RabbitMQ中的MQTT消息不会被丢失

确保RabbitMQ中MQTT消息不丢失，需要综合考虑消息的持久性、网络通信的可靠性、消息确认机制等多个方面。



![Mermaid 图表](/images/mermaid/mermaid-7ddaf8d8-1.svg)



## 三、如何确保RabbitMQ中的MQTT消息的顺序性



![Mermaid 图表](/images/mermaid/mermaid-c40c7ec0-2.svg)



## 四、如何确保RabbitMQ中的MQTT消息持久化


![Mermaid 图表](/images/mermaid/mermaid-4a29c601-3.svg)

