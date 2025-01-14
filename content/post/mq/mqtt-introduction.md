+++
date = '2022-12-07T21:00:20+08:00'
title = '认识MQTT（一）：MQTT是什么'
draft = false
mermaid = true
categories = ['消息队列']
tags = ['消息队列', '通信协议']
+++

和车打交道后，接触到了`MQTT`，第一次听到这个词时，我还疑心自己是不是听错了，问Leader是不是`MQ`，得到了“不是”的答复，遂有此文，总结一下我所了解的`MQTT`。

<!--more-->

## 一、MQTT的应用场景

{{< mermaid bc="#white" >}}
graph LR
    subgraph 车辆集群
        A1[车辆1]
        A2[车辆2]
        A3[车辆3]
    end

    B[MQTT Broker]

    subgraph 服务器集群
        C[业务服务器]
        D[TSP平台]
        E[终端应用]
    end

    A1 -->|发布/订阅消息| B
    A2 -->|发布/订阅消息| B
    A3 -->|发布/订阅消息| B
    B -->|发布/订阅消息| C
    B -->|发布/订阅消息| D
    B -->|发布/订阅消息| E
{{< /mermaid >}}

`MQTT`在车联网中主要应用在以下几个方面：

1. **车辆实时监控**：通过`MQTT`协议，车辆可以实时将其位置、速度、状态等信息发布到一个或多个监控中心。监控中心可以订阅这些信息并进行实时监控和分析，以提供实时的车辆位置跟踪和监控。

2. **车辆远程控制**：通过`MQTT`协议，车辆可以接收来自远程控制中心的指令，并执行相应的操作，如开关车门、启动引擎、调整车辆参数等，这样可以实现远程监控和控制车辆的功能。

3) **车辆数据采集与共享**：通过`MQTT`协议，车辆可以将其传感器和系统收集到的数据发布到一个或多个数据中心。数据中心可以订阅这些数据，并进行分析和共享，以支持车辆管理、故障诊断、预测维护等功能。

4) **车辆交互和通信**：通过使用`MQTT`协议，车辆可以与其他车辆、交通设施和智能交通系统进行实时交互和通信。例如，车辆可以发布其位置和行驶意图，以提供给其他车辆和交通设施，从而实现车辆之间的协同行驶和交通流优化。

在数据传输、设备管理、远程控制和车辆间通信等方面，`MQTT`以轻量级、低能耗、开放性、可靠性、异步通信、灵活性和实时性等优势成为车联网领域理想的通信协议。

## 二、什么是MQTT

上面的应用场景中，可以看到`MQTT`是一个协议，而我们知道`MQ`是一个中间件，二者在定义上就有了区别。

* MQTT（Message Queuing Telemetry Transport）：一种**应用层的消息协议**，独立于传输层协议，可以运行在`TCP/TLS`或`UDP`上。

* MQ（Message Queue）：通常指消息队列，如RabbitMQ、ActiveMQ等，**实现了特定的消息传递协议**，如AMQP、STOMP等。

## 三、MQTT和MQ的对比

|               | **MQTT**                                                                                                      | **MQ**                                             |
| ------------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| **定义**        | MQTT是一种轻量级的消息传输协议，专为低带宽、高延迟或不稳定的网络环境设计。                                                                       | 传统的消息队列是一种中间件，用于在分布式系统中异步传输消息。                     |
| **消息模型**      | **发布/订阅**模式。                                                                                                  | 支持**发布/订阅**模式、**点对点**等多种模式。                        |
| **系统组件**      | 通过一个消息中间件（Broker）来实现消息的发布和订阅。                                                                                 | 通常包含消息代理（Queue Manager）和消息队列（Queue），消息被放入队列并按顺序处理。 |
| **服务质量（QoS）** | 提供三种服务质量等级：</br>QoS 0：最多一次，消息的传输依赖于网络环境，可能出现消息丢失的情况；</br>QoS 1：至少一次，消息保证能够到达，但可能出现重复；</br>QoS 2：正好一次，消息保证只到达一次，不会出现重复或丢失的情况。 | QoS的实现可能因不同的MQ产品而异。                                |
| **持久化**       | 支持消息的持久化，依赖于实现MQTT的Broker服务器来提供，**不支持存储转发队列功能。**                                                              | 持久化包括消息和队列的持久化。                                    |
| **复杂性**       | 协议简单，易于实现，适合资源受限的环境。                                                                                          | 提供丰富的功能和选项，适合需要复杂消息路由和处理的场景。                       |
| **扩展性**       | 支持大规模的客户端连接，适合物联网场景。                                                                                          | 支持扩展性，但可能在大量简单连接的场景下不如MQTT高效。                      |
| **安全性**       | 支持TLS/SSL加密和客户端认证。                                                                                            | 提供多种安全机制，包括访问控制、加密和认证。                             |

虽然`MQTT`和`MQ`不能在一个层面上进行比较，但他们依然有很多相似之处，比如`MQTT`支持发布/订阅模式，支持消息的持久化，这些都和`MQ`有共通之处，其实是和`MQ`实现的协议比如`AMQP`有共通之处。

## 四、MQTT和AMQP的对比

| 特性                     | MQTT                                 | AMQP                                |
| ---------------------- | ------------------------------------ | ----------------------------------- |
| **英文全称**               | Message Queueing Telemetry Transport | Advanced Message Queuing Protocol   |
| **起源**                 | 由IBM于1999年发明                         | 由摩根大通于2003年发明                       |
| **架构**                 | 基于主题的发布/订阅                           | 交换机-绑定-队列（EBQ）                      |
| **核心概念**               | 主题，订阅                                | 交换机，队列，绑定，路由键                       |
| **主要协议版本**             | 3.1.1 于2015年12月发布；5.0 于2019年3月发布     | 0.9.1 于2008年11月发布；1.0于2012年10月发布    |
| **消息范式**               | 部分支持点对点、发布/订阅、扇出、扇入、5.0版本中支持请求/响应    | 点对点、发布/订阅、扇出、扇入、请求/响应               |
| **传输**                 | TCP、TLS/SSL、**WebSocket、QUIC**           | TCP、TLS/SSL                         |
| **帧结构**                | MQTT控制报文由固定头部、可变头部、有效载荷组成            | 固定长度的帧头部、可变长度的扩展头部、可变长度的帧体          |
| **固定头部大小**             | **2字节**                                  | 8字节                                 |
| **最大有效载荷大小**           | **256MB**                                | 2GB                                 |
| **QoS**                | QoS 0: 最多一次；QoS 1: 至少一次；QoS 2: 正好一次  | QoS 0: 最多一次；QoS 1: 至少一次（不直接支持QoS 2） |
| **存储转发队列**             | **不支持**                                  | 支持                                  |
| **遗嘱消息（Will Message）** | **支持**                                   | 不支持                                 |
| **灵活的消息路由**            | 简单的路由机制                              | 提供多种消息路由方式                          |
| **复杂性**                | 简单，易于配置、开发和管理                        | 复杂，涉及许多概念                           |
| **向后兼容性**              | 较好                                   | 0.9.1版本和1.0版本完全不兼容                  |
| **可扩展性和性能**            | 支持千万级的MQTT连接、主题和订阅                   | 可能受限                                |
| **生态系统**               | 广泛支持多种编程语言、操作系统和软件平台                 | 丰富而成熟的开源服务器实现和客户端库                  |
| **安全性**                | 支持TLS/SSL安全通信，提供多种认证方式               | 支持TLS、SASL等加密和认证安全机制                |

通过上面的对比，可以看到，即使`MQ`也使用和`MQTT`一样的的发布/订阅模型，但因为`MQTT`非常轻量级，消息头部最小只有2字节，适合传输小消息，这一点在**低带宽**和**不稳定网络环境**的场景下，就秒杀了`MQ`。

## 五、小结

综上所述，MQTT更适用于支持高并发连接不是没有原因的。

* **轻量级协议**：MQTT协议的消息头最小只有2字节，整个协议设计简洁，这减少了消息的大小和复杂性，使得**在有限的带宽下可以处理更多的连接**。

* **发布/订阅模型**：采用发布/订阅模式，消息发布者无需知道订阅者的存在，**解耦生产者和消费者**。

* **共享订阅**：发布/订阅模型允许单个消息被多个订阅者接收，**减少了需要发送的总消息数**，提高通信效率。

* **保持连接**：MQTT客户端与服务器之间的长连接，**减少了频繁建立和断开连接的开销**。

* **遗嘱消息**：支持遗嘱消息机制，允许在客户端异常断开时通知服务器。

* **异步通信**：MQTT的异步消息传递特性意味着服务器不需要为每个请求维护一个状态，**降低了服务器处理大量连接时的负担**。

* **可扩展性**：支持集群和分布式架构，可以水平扩展**处理大量的并发连接**。
