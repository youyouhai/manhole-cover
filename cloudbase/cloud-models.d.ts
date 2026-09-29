
import { DataModelMethods } from "@cloudbase/wx-cloud-client-sdk";
interface IModalSysDepartment {
/**
 * 部门名称
 * 
 */
departmentName: string
/**
 * 所有人
 * 
 */
owner?: string
/**
 * 上级部门
 * 
 */
departmentParentCode?: string
/**
 * 部门编码
 * 
 */
departmentCode: string
/**
 * 部门来源
 * 部门来源
 */
source?: number
/**
 * 权重
 * 
 */
_sort?: number
/**
 * 创建时间
 * 
 */
createdAt?: number
/**
 * 部门负责人
 * 
 */
departmentOwnerList?: string[]
/**
 * 创建人
 * 
 */
createBy?: string
/**
 * 节点深度
 * 
 */
depth?: number
/**
 * 修改人
 * 
 */
updateBy?: string
/**
 * 数据标识
 * 
 */
_id?: string
/**
 * 更新时间
 * 
 */
updatedAt?: number
}

interface IModalSysUser {
/**
 * 微信id
 * 
 */
open_id?: string
/**
 * 用户来源
 * 
 */
source: number
/**
 * 用户类型
 * 
 */
type: number
/**
 * uuid
 * 
 */
uuid?: string
/**
 * 主岗部门
 * 
 */
main_dep?: string
/**
 * 权重
 * 
 */
_sort?: number
/**
 * 创建时间
 * 
 */
createdAt?: number
/**
 * 修改人
 * 
 */
updateBy?: string
/**
 * 项目id
 * 
 */
project_id?: number
/**
 * 头像
 * 
 */
_avatar?: string
/**
 * 集团用户id
 * 
 */
uin: string
/**
 * 邮箱
 * 
 */
email?: string
/**
 * 更新时间
 * 
 */
updatedAt?: number
/**
 * 所有人
 * 
 */
owner?: string
/**
 * 直属上级id
 * 
 */
parent_user_id?: string
/**
 * 用户描述
 * 
 */
user_desc?: string
/**
 * 企业微信用户id
 * 
 */
wechat_user_id?: string
/**
 * 创建人
 * 
 */
createBy?: string
/**
 * env_id
 * 
 */
env_id?: string
/**
 * 手机号
 * 
 */
phone?: string
/**
 * 用户昵称
 * 
 */
nick_name?: string
/**
 * latest_visitAt
 * 最近访问时间
 */
latest_visitAt?: number
/**
 * 用户名称
 * 
 */
name?: string
/**
 * 内部用户类型
 * 
 */
internal_user_type?: number
/**
 * 数据标识
 * 
 */
_id?: string
/**
 * 企业id
 * 
 */
corp_id?: string
/**
 * 子用户id
 * 
 */
sub_uin: string
}


interface IModels {

    /**
    * Data Model：部门
    */ 
    sys_department: DataModelMethods<IModalSysDepartment>;

    /**
    * Data Model：用户
    */ 
    sys_user: DataModelMethods<IModalSysUser>;    
}

declare module "@cloudbase/wx-cloud-client-sdk" {
    interface OrmClient extends IModels {}
}

declare global {
    interface WxCloud {
        models: IModels;
    }
}