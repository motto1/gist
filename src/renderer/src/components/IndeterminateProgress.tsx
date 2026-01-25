import React from 'react'
import styled, { keyframes } from 'styled-components'

/**
 * 滑动渐变进度条组件
 * 持续显示从左到右的滑动动画效果,不显示具体进度
 * 具体进度由下方文字显示
 */
export const IndeterminateProgress: React.FC = () => {
  return (
    <SlideContainer>
      <SlideBar />
    </SlideContainer>
  )
}

// 从左到右的滑动动画
const slide = keyframes`
  0% {
    left: -40%;
  }
  100% {
    left: 100%;
  }
`

const SlideContainer = styled.div`
  width: 100%;
  height: 8px;
  background-color: rgba(16, 163, 127, 0.1);
  border-radius: 100px;
  overflow: hidden;
  position: relative;
`

const SlideBar = styled.div`
  position: absolute;
  width: 40%;
  height: 100%;
  background: linear-gradient(90deg, transparent, #10a37f, transparent);
  animation: ${slide} 1.5s ease-in-out infinite;
  border-radius: 100px;
`