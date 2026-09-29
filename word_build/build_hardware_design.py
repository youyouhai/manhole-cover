from pathlib import Path
from docx import Document
from docx.shared import Inches, Pt, RGBColor
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.enum.table import WD_TABLE_ALIGNMENT, WD_CELL_VERTICAL_ALIGNMENT
from docx.enum.text import WD_BREAK
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(r"C:\Users\Lenovo\Desktop\work\project")
REF = ROOT / ".ppt-image-deck" / "references"
OUT = ROOT / "output" / "docx" / "智能井盖监测系统-硬件设计说明-可提交版.docx"
BUILD = ROOT / "word_build" / "hardware_doc"
BUILD.mkdir(parents=True, exist_ok=True)
OUT.parent.mkdir(parents=True, exist_ok=True)

FONTFILE = r"C:\Windows\Fonts\simhei.ttf"

def shade(cell, color):
    tcPr = cell._tc.get_or_add_tcPr()
    shd = OxmlElement("w:shd")
    shd.set(qn("w:fill"), color)
    tcPr.append(shd)

def margins(cell, top=90, start=100, bottom=90, end=100):
    tc = cell._tc
    tcPr = tc.get_or_add_tcPr()
    mar = tcPr.first_child_found_in("w:tcMar")
    if mar is None:
        mar = OxmlElement("w:tcMar")
        tcPr.append(mar)
    for tag, val in (("top", top), ("start", start), ("bottom", bottom), ("end", end)):
        node = mar.find(qn(f"w:{tag}"))
        if node is None:
            node = OxmlElement(f"w:{tag}")
            mar.append(node)
        node.set(qn("w:w"), str(val))
        node.set(qn("w:type"), "dxa")

def set_borders(table):
    tblPr = table._tbl.tblPr
    borders = tblPr.first_child_found_in("w:tblBorders")
    if borders is None:
        borders = OxmlElement("w:tblBorders")
        tblPr.append(borders)
    for edge in ("top", "left", "bottom", "right", "insideH", "insideV"):
        el = OxmlElement(f"w:{edge}")
        el.set(qn("w:val"), "single")
        el.set(qn("w:sz"), "4")
        el.set(qn("w:color"), "D9D9D9")
        borders.append(el)

def style_run(run, size=9, bold=False, color=(20, 30, 43)):
    run.font.name = "SimHei"
    run.font.size = Pt(size)
    run.font.bold = bold
    run.font.color.rgb = RGBColor(*color)
    run._element.rPr.rFonts.set(qn("w:eastAsia"), "SimHei")

def para(text="", style=None, size=9.5, bold=False, space=5, align=None):
    p = doc.add_paragraph(style=style)
    p.paragraph_format.space_after = Pt(space)
    p.paragraph_format.line_spacing = 1.18
    if align is not None:
        p.alignment = align
    if text:
        style_run(p.add_run(text), size=size, bold=bold)
    return p

def heading(text, level=1):
    p = doc.add_paragraph(style=f"Heading {level}")
    p.paragraph_format.space_before = Pt(10 if level == 1 else 6)
    p.paragraph_format.space_after = Pt(5)
    style_run(p.add_run(text), size=14 if level == 1 else 11, bold=True, color=(0, 0, 0))
    return p

def table(headers, rows, widths, size=8.3):
    t = doc.add_table(rows=1, cols=len(headers))
    t.alignment = WD_TABLE_ALIGNMENT.CENTER
    t.autofit = False
    set_borders(t)
    for i, (head, width) in enumerate(zip(headers, widths)):
        t.columns[i].width = Inches(width)
        c = t.rows[0].cells[i]
        c.width = Inches(width)
        c.text = ""
        shade(c, "17365D")
        margins(c)
        c.vertical_alignment = WD_CELL_VERTICAL_ALIGNMENT.CENTER
        p = c.paragraphs[0]
        p.paragraph_format.space_after = Pt(0)
        style_run(p.add_run(head), size=size, bold=True, color=(255, 255, 255))
    for ri, row in enumerate(rows):
        cells = t.add_row().cells
        for i, value in enumerate(row):
            c = cells[i]
            c.width = Inches(widths[i])
            c.text = ""
            margins(c)
            c.vertical_alignment = WD_CELL_VERTICAL_ALIGNMENT.CENTER
            if ri % 2:
                shade(c, "F2F6FA")
            p = c.paragraphs[0]
            p.paragraph_format.space_after = Pt(0)
            p.paragraph_format.line_spacing = 1.1
            style_run(p.add_run(str(value)), size=size)
    t.rows[0]._tr.get_or_add_trPr().append(OxmlElement("w:tblHeader"))
    doc.add_paragraph().paragraph_format.space_after = Pt(0)
    return t

def picture(path, width, caption):
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p.paragraph_format.space_after = Pt(3)
    p.add_run().add_picture(str(path), width=Inches(width))
    para(caption, size=8, space=7, align=WD_ALIGN_PARAGRAPH.CENTER)

def page():
    doc.add_page_break()

def make_diagram():
    W, H = 1700, 730
    im = Image.new("RGB", (W, H), "white")
    d = ImageDraw.Draw(im)
    title = ImageFont.truetype(FONTFILE, 39)
    normal = ImageFont.truetype(FONTFILE, 30)
    small = ImageFont.truetype(FONTFILE, 25)
    navy, blue, pale, line = "#17365D", "#1376B5", "#EAF3F8", "#5B7487"
    def box(x0,y0,x1,y1,t,sub=""):
        d.rounded_rectangle((x0,y0,x1,y1), radius=16, fill=pale, outline=blue, width=3)
        bb=d.textbbox((0,0),t,font=normal)
        d.text(((x0+x1-(bb[2]-bb[0]))/2,y0+21),t,font=normal,fill=navy)
        if sub:
            bb=d.textbbox((0,0),sub,font=small)
            d.text(((x0+x1-(bb[2]-bb[0]))/2,y0+65),sub,font=small,fill="#334F61")
    def arrow(points):
        d.line(points, fill=line, width=5, joint="curve")
        x,y=points[-1]
        d.polygon(((x,y),(x-15,y-9),(x-15,y+9)),fill=line)
    d.text((25,15),"电气连接原理图（功能级）",font=title,fill=navy)
    box(625,285,1075,440,"ESP32-S3 传感主控","两块 ESP32 独立运行")
    for y,t,s in [(100,"GY-521 姿态","GPIO8 SDA / GPIO9 SCL"),(255,"US-100 水位","GPIO16 Trig / GPIO17 Echo"),(410,"双霍尔在位","GPIO7 / GPIO10")]:
        box(35,y,475,y+115,t,s)
        arrow([(475,y+58),(625,y+58)])
    for y,t,s in [(100,"声光报警","GPIO2/4/5/6"),(255,"M100PG Cat.1","GPIO18 TX / GPIO21 RX"),(410,"ESP32-S3-CAM","GPIO13 TX → GPIO14 RX")]:
        box(1225,y,1665,y+115,t,s)
        arrow([(1075,y+58),(1225,y+58)])
    d.line((65,610,1635,610),fill=blue,width=3)
    d.text((75,628),"公共 GND：传感主控、通信底板、相机板及传感器共地；供电按各模块额定电压分别处理。",font=small,fill=navy)
    out = BUILD / "电气连接原理图.png"
    im.save(out)
    return out

doc = Document()
sec = doc.sections[0]
sec.page_width = Inches(8.5)
sec.page_height = Inches(11)
sec.top_margin = Inches(0.65)
sec.bottom_margin = Inches(0.62)
sec.left_margin = Inches(0.72)
sec.right_margin = Inches(0.72)
styles = doc.styles
styles["Normal"].font.name = "SimHei"
styles["Normal"].font.size = Pt(9.5)
styles["Normal"]._element.rPr.rFonts.set(qn("w:eastAsia"), "SimHei")
for name in ("Title", "Heading 1", "Heading 2"):
    styles[name].font.name = "SimHei"
    styles[name].font.color.rgb = RGBColor(0,0,0)
    styles[name]._element.rPr.rFonts.set(qn("w:eastAsia"), "SimHei")

# 1 封面与摘要
p=doc.add_paragraph(style="Title")
p.paragraph_format.space_after=Pt(12)
style_run(p.add_run("智能井盖监测系统硬件设计说明"),size=22,bold=True,color=(0,0,0))
para("硬件赛道提交材料  |  版本 1.0  |  2026 年 9 月",size=9,space=12)
para("本说明书说明智能井盖原型的器件选型、两块 ESP32-S3 的功能分工、实际固件引脚、无线通信与摄像联动接线、供电注意事项及实物安装。图示为功能级电气连接，接线表以当前项目固件为准。",size=10.5,space=12)
picture(REF/"prototype"/"assembled-prototype.jpg",6.85,"图 1  井盖原型背面实物照片，展示阶段的器件和走线状态")
heading("设计结论")
para("系统由传感主板、独立相机板和 Cat.1/GPS 通信组件构成。传感主板采集姿态、水面净空和双霍尔状态，驱动声光报警，并通过 M100PG Cat.1 通道上传遥测；相机板通过手机 2.4 GHz 热点联网，接收传感主板的单向串口告警指令，拍摄并上传现场照片。",size=9.5,space=5)
para("本样机采用杜邦线和模块化器件搭建；图 1 不能替代长期户外部署所需的防水、固定、抗振与绝缘结构设计。",size=8.8,space=0)

# 2 架构与电气连接图
page(); heading("1 系统结构与电气连接")
para("主控和相机是两块独立 ESP32-S3 板。前者负责传感、报警与 Cat.1 遥测，后者负责拍照与 Wi-Fi 上传；两板仅用一根串口信号线传递自动拍照指令，并共地。",space=9)
picture(make_diagram(),6.95,"图 2  功能级电气连接原理图；引脚级关系见第 3、4 节接线表")
table(["单元","器件组成","职责"],[
    ("传感控制","ESP32-S3、GY-521、US-100、双霍尔、两类蜂鸣器、指示灯","实时采集、状态判断、本地声光报警"),
    ("公网通信","M100PG Cat.1/GPS 模组、测试底板、SIM、4G 与 GPS 天线","4G 数据链路和定位，向网站上报"),
    ("图片采集","GOOUUU ESP32-S3-CAM、OV2640 摄像头","手动或告警触发拍照，经 Wi-Fi 上传照片"),
    ("供电","可充电电池包、所需稳压/保护环节","向各板提供与其额定值相符的电源"),
], [1.0,2.7,3.35],size=8.5)
para("注意：图 2 只表示信号流，不表示供电可直接并接。实物电池的标称电压、容量与保护板参数应以电池标签和测量结果为准。",size=8.5,space=0)

# 3 传感器接线
page(); heading("2 传感主板与传感器接线表")
para("下表来自传感主板固件 src/main.cpp 的引脚定义和初始化代码。GPIO 均指传感主板丝印数字引脚，不是板上标作 TX、RX 的默认串口焊盘。",space=8)
table(["模块或端子","接到传感主板","作用与核对事项"],[
    ("GY-521 SDA","GPIO8","I²C 数据线；模块地址默认 0x68"),
    ("GY-521 SCL","GPIO9","I²C 时钟线"),
    ("GY-521 VCC/GND","3V3 / GND","按 3.3 V I²C 接线；AD0 保持低电平"),
    ("US-100 Trig/Tx","GPIO16","超声波触发输出；固件使用 Trig/Echo 模式"),
    ("US-100 Echo/Rx","GPIO17","回波输入；若模块以 5 V 工作，先降至 3.3 V 逻辑"),
    ("US-100 VCC/GND","按实物规格 / GND","典型模块用 5 V；通电前核对所购板供电标识"),
    ("左霍尔 OUT","GPIO7","内部上拉，低电平表示检测到磁体"),
    ("右霍尔 OUT","GPIO10","内部上拉，低电平表示检测到磁体"),
    ("霍尔 VCC/GND","按实物规格 / GND","若模块 OUT 为 5 V，须加电平转换后再进 ESP32"),
], [1.55,1.55,3.95],size=8.5)
heading("工作判定")
para("US-100 每约 200 ms 采样一次探头到水面的距离。双霍尔先完成输入消抖与状态确认；两侧持续失去磁体 10 s 才触发离位报警。姿态角持续落入危险区间 10 s 后才确认倾斜报警，避免瞬时震动误触发。恢复正常位置并稳定 20 s 后，系统可解除报警。",size=9.2)
para("电平保护：ESP32-S3 GPIO 属于 3.3 V 逻辑，不能把未确认的 5 V Echo 或霍尔 OUT 直接接入。",size=9,bold=True,space=0)

# 4 报警、通信和相机接线
page(); heading("3 报警输出与板间通信接线表")
table(["功能","接线关系","程序定义与说明"],[
    ("姿态报警灯","传感主板 GPIO2 → 红色指示灯控制端","高电平点亮；模块电源和 GND 按实物标识连接"),
    ("有源蜂鸣器","传感主板 GPIO4 → 蜂鸣器控制端","高电平有效；大电流负载应加驱动级"),
    ("水位提示灯","传感主板 GPIO5 → 指示灯控制端","按水位等级常亮或闪烁"),
    ("无源蜂鸣器","传感主板 GPIO6 → 蜂鸣器控制端","LEDC 输出不同频率的提示音"),
    ("Cat.1 上行串口","传感主板 GPIO18 TX → M100PG 底板 RXD","115200 bit/s，8N1；TX/RX 交叉"),
    ("Cat.1 下行串口","M100PG 底板 TXD → 传感主板 GPIO21 RX","底板应接模组侧接口；具体排针以实物丝印核对"),
    ("相机告警链路","传感主板 GPIO13 TX → 相机板 GPIO14 RX","115200 bit/s，8N1，仅单向；自动拍 5 张"),
    ("公共地","传感主板 GND ↔ Cat.1 底板 GND ↔ 相机 GND","不同电源供电时仍需建立信号参考地"),
    ("相机 BOOT","相机板自带 GPIO0 按键","本地触发；烧录/复位时不要长按"),
], [1.35,3.0,2.7],size=8.3)
heading("通信与联动流程")
para("传感主板每 20 s 整合姿态、水位、霍尔和定位信息，经 UART 送至 Cat.1 模组上报网站。确认倾斜或井盖离位报警时，GPIO13 发送 CAPTURE,5 指令；独立相机板从 GPIO14 接收后执行 5 张连拍，并通过已连接的 2.4 GHz 热点上传。网页还可远程选择单拍、连拍 3 张或 5 张。",size=9.2)
para("相机与 Cat.1 是不同的数据通道。Cat.1 上报传感器数据不要求 GPS 先定位成功；GPS/LBS 只影响位置字段。",size=9.2,space=0)

# 5 电源和安装
page(); heading("4 供电与现场安装")
para("照片中的蓝色电池包带充放电接口，但照片不能可靠读出标称电压、容量和最大输出电流。电池输出不得直接接 ESP32 的 3V3 引脚；应先核对电池标签，再按主板、相机板及通信底板各自的输入要求配置稳压和保护。",space=8)
picture(REF/"prototype"/"rechargeable-battery.jpg",4.45,"图 3  可充放电电池包外观；最终参数应核对实物铭牌")
table(["供电对象","接法原则","提交前核对"],[
    ("传感 ESP32-S3","用稳定的板级输入电源供电；与外设共地","输入电压、极性和瞬态压降"),
    ("ESP32-S3-CAM","单独获得稳定的板级输入电源；与传感板共地","连续拍摄和 Wi-Fi 上传时是否复位"),
    ("Cat.1 测试底板","按实物底板 DC 输入标识供电；不可从 GPIO 供电","启动及发射电流、跳帽与供电路径"),
    ("US-100 与霍尔","按模块标称电压供电，并保护返回的 GPIO 信号","Echo/OUT 的实测高电平不超过 3.3 V"),
], [1.45,3.15,2.45],size=8.1)
heading("井盖结构安排")
para("展示样机将 4G 通信、GPS 天线、两只蜂鸣器和两只指示灯放在井盖正面；主控、姿态、水位、相机及电池固定在背面；两个霍尔元件位于井盖与井框的衔接处，与磁体成对。US-100 探头面向井下水面。现场部署还应增加防水壳体、线束固定、绝缘与防拉脱设计。",size=9.1,space=0)

# 6 BOM
page(); heading("5 主要器件清单 BOM")
para("数量按本原型的功能配置列出；不填写未经确认的采购价格或电池容量。M100PG 为项目使用的通信模组名称，所附同系列套件照片的印字可能不同，最终以实际装机模组为准。",space=8)
table(["序号","器件","数量","用途或位置"],[
    ("01","ESP32-S3 开发板，双 USB-C","1","传感与报警主控"),
    ("02","GOOUUU ESP32-S3-CAM / OV2640","1","独立图像采集板"),
    ("03","US-100 超声波测距模块","1","井下水面净空监测"),
    ("04","GY-521 MPU-6050 姿态模块","1","井盖倾角检测"),
    ("05","霍尔检测模块与磁体","2 组","井盖在位/离位检测"),
    ("06","有源蜂鸣器模块","1","本地报警"),
    ("07","无源蜂鸣器模块","1","分级提示音"),
    ("08","LED 指示模块","2","姿态/水位声光提示"),
    ("09","M100PG Cat.1/GPS 模组与测试底板","1 套","4G 遥测和定位"),
    ("10","4G 天线、GPS 有源天线","各 1","蜂窝网络与卫星信号"),
    ("11","可充放电电池包","1","独立供电，参数以实物铭牌为准"),
    ("12","SIM 卡、连接线、固定材料","若干","网络接入与原型装配"),
], [0.45,3.1,0.65,2.85],size=8.1)
para("注：稳压器、电平转换器、保护元件是否已经安装，需在最终装配照片和实物接线中确认；若未安装，不应在 BOM 中宣称为现有器件。",size=8.5,space=0)

# 7 照片与验证
page(); heading("6 器件与实物照片")
para("下列照片为项目使用或选型参考的模块外观；安装状态以图 1 的实物照片为准。",space=5)
photos=[
    ("esp32-s3-main.jpg","传感主控 ESP32-S3"),
    ("us-100.jpg","US-100 超声波模块"),
    ("mpu6050-front.jpg","GY-521 姿态模块"),
    ("hall-modules.jpg","双霍尔模块"),
    ("goouuu-esp32-s3-cam.jpg","独立摄像头板"),
    ("y100e-cat1-gps-kit.jpg","Cat.1/GPS 同系列套件参考"),
]
for j in range(0,len(photos),2):
    t=doc.add_table(rows=2,cols=2)
    t.autofit=False
    for k,(fn,label) in enumerate(photos[j:j+2]):
        cell=t.cell(0,k); cell.text=""; cell.vertical_alignment=WD_CELL_VERTICAL_ALIGNMENT.CENTER
        cell.paragraphs[0].alignment=WD_ALIGN_PARAGRAPH.CENTER
        cell.paragraphs[0].add_run().add_picture(str(REF/"hardware"/fn),height=Inches(1.05))
        cell=t.cell(1,k); cell.text=""; cell.paragraphs[0].alignment=WD_ALIGN_PARAGRAPH.CENTER
        style_run(cell.paragraphs[0].add_run(label),size=8.1)
    doc.add_paragraph().paragraph_format.space_after=Pt(0)
heading("7 通电与功能核验")
para("建议依次检查：① 各电源轨电压和极性；② MPU-6050 I²C 地址及姿态角变化；③ US-100 回波电平、测距更新和 GPIO17 波形；④ 双霍尔单侧/双侧移磁后状态变化；⑤ 两类蜂鸣器和指示灯；⑥ M100PG 网络就绪与 20 s 遥测；⑦ 相机板本地拍照、串口自动 5 连拍和网页照片可见。",size=8.9,space=7)
para("设计依据：本项目传感固件 src/main.cpp；相机固件 camera/src/main.cpp 与 camera/include/board_config.h；ESP32-S3 官方数据手册；US-100 模块资料。展示照片不等同于经计量认证的测试结果。",size=8.2,space=0)

doc.save(OUT)
print(OUT)
