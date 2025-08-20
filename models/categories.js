import mongoose from 'mongoose';
const { Schema, model } = mongoose;

const LocalizedStringSchema = new Schema({
    en: { type: String, required: true },
    uz: { type: String, required: true },
    ru: { type: String, required: true },
}, { _id: false }); t


const CategorySchema = new Schema({
    id: {
        type: String,
        required: true,
        unique: true,
    },
    title: {
        type: LocalizedStringSchema,
        required: true,
    },
    route: {
        type: String,
        required: true,
    },
    icon: {
        type: String,
        required: true,
    },
}, {
    timestamps: true, 
    versionKey: false, 
});

const Category = model('Category', CategorySchema, 'categoryData');

export default Category;
